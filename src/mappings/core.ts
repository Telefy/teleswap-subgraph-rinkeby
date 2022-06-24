/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, Address, log } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  TeleswapFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle
} from '../../generated/schema'
import { Pair as PairContract, Mint, Burn, Swap, Transfer, Sync } from '../../generated/templates/Pair/Pair'
import { updatePairDayData, updateTokenDayData, updateTeleswapDayData, updatePairHourData } from './dayUpdates'
import { getEthPriceInUSD, findEthPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  createUser,
  createLiquidityPosition,
  ZERO_BD,
  BI_18,
  createLiquiditySnapshot
} from './helpers'

function isCompleteMint(mintId: string): boolean {
  let returnVar = false;
  const mintVar = MintEvent.load(mintId);
  if (mintVar && mintVar.sender !== null)
    returnVar = true
  return returnVar // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  let factory = TeleswapFactory.load(FACTORY_ADDRESS)
  let transactionHash = event.transaction.hash.toHexString()

  // user stats
  let from = event.params.from
  createUser(from)
  let to = event.params.to
  createUser(to)

  // get pair and load contract
  let pair = Pair.load(event.address.toHexString())
  let pairContract = PairContract.bind(event.address)

  // liquidity token amount being transfered
  let value = convertTokenToDecimal(event.params.value, BI_18)
  if (pair) {
    // get or create transaction
    let transaction = Transaction.load(transactionHash)
    if (transaction === null) {
      transaction = new Transaction(transactionHash)
      transaction.blockNumber = event.block.number
      transaction.timestamp = event.block.timestamp
      transaction.mints = []
      transaction.burns = []
      transaction.swaps = []
    }

    // mints
    let mints = transaction.mints
    if (mints) {
      if (from.toHexString() == ADDRESS_ZERO) {
        // update total supply
        pair.totalSupply = pair.totalSupply.plus(value)
        pair.save()

        // create new mint if no mints so far or if last one is done already
        if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
          let mint = new MintEvent(
            event.transaction.hash
              .toHexString()
              .concat('-')
              .concat(BigInt.fromI32(mints.length).toString())
          )
          mint.transaction = transaction.id
          mint.pair = pair.id
          mint.to = to
          mint.liquidity = value
          mint.timestamp = transaction.timestamp
          mint.transaction = transaction.id
          mint.save()

          // update mints in transaction
          transaction.mints = mints.concat([mint.id])

          // save entities
          transaction.save()
          if (factory)
            factory.save()
        }
      }
    } else {
      mints = [];
    }

    // case where direct send first on ETH withdrawls
    if (event.params.to.toHexString() == pair.id) {
      let burns = transaction.burns
      if (!burns) {
        burns = []
      }
      let burn = new BurnEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(burns.length).toString())
      )
      burn.transaction = transaction.id
      burn.pair = pair.id
      burn.liquidity = value
      burn.timestamp = transaction.timestamp
      burn.to = event.params.to
      burn.sender = event.params.from
      burn.needsComplete = true
      burn.transaction = transaction.id
      burn.save()

      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id)
      transaction.burns = burns
      transaction.save()
    }

    // burn
    if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
      pair.totalSupply = pair.totalSupply.minus(value)
      pair.save()

      // this is a new instance of a logical burn
      let burns = transaction.burns
      if (!burns) {
        burns = [];
      }
      let burn: BurnEvent
      if (burns.length > 0) {
        let currentBurn = BurnEvent.load(burns[burns.length - 1])
        if (currentBurn && currentBurn.needsComplete) {
          burn = currentBurn as BurnEvent
        } else {
          burn = new BurnEvent(
            event.transaction.hash
              .toHexString()
              .concat('-')
              .concat(BigInt.fromI32(burns.length).toString())
          )
          burn.transaction = transaction.id
          burn.needsComplete = false
          burn.pair = pair.id
          burn.liquidity = value
          burn.transaction = transaction.id
          burn.timestamp = transaction.timestamp
        }
      } else {
        burn = new BurnEvent(
          event.transaction.hash
            .toHexString()
            .concat('-')
            .concat(BigInt.fromI32(burns.length).toString())
        )
        burn.transaction = transaction.id
        burn.needsComplete = false
        burn.pair = pair.id
        burn.liquidity = value
        burn.transaction = transaction.id
        burn.timestamp = transaction.timestamp
      }

      // if this logical burn included a fee mint, account for this
      if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
        let mint = MintEvent.load(mints[mints.length - 1])
        if (mint) {
          burn.feeTo = mint.to
          burn.feeLiquidity = mint.liquidity
        }
        // remove the logical mint
        store.remove('Mint', mints[mints.length - 1])
        // update the transaction

        // TODO: Consider using .slice().pop() to protect against unintended
        // side effects for other code paths.
        mints.pop()
        transaction.mints = mints
        transaction.save()
      }
      burn.save()
      // if accessing last one, replace it
      if (burn.needsComplete) {
        // TODO: Consider using .slice(0, -1).concat() to protect against
        // unintended side effects for other code paths.
        burns[burns.length - 1] = burn.id
      }
      // else add new one
      else {
        // TODO: Consider using .concat() for handling array updates to protect
        // against unintended side effects for other code paths.
        burns.push(burn.id)
      }
      transaction.burns = burns
      transaction.save()
    }

    if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
      let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
      fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), BI_18)
      fromUserLiquidityPosition.save()
      createLiquiditySnapshot(fromUserLiquidityPosition, event)
    }

    if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
      let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
      toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), BI_18)
      toUserLiquidityPosition.save()
      createLiquiditySnapshot(toUserLiquidityPosition, event)
    }

    transaction.save()
  }
}

export function handleSync(event: Sync): void {
  log.debug("SYNC EVENT 1 -----" + event.params.reserve0.toString(), [])
  let pair = Pair.load(event.address.toHexString())
  if (pair) {
    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    log.debug("SYNC EVENT 2 ----- token 0: " + pair.token0.toString(), [])
    log.debug("SYNC EVENT 3 ----- token 1: " + pair.token1.toString(), [])

    let teleswap = TeleswapFactory.load(FACTORY_ADDRESS)
    log.debug("SYNC EVENT 4 ----- factory: " + FACTORY_ADDRESS, [])

    if (token0 && token1 && teleswap) {
      log.debug("SYNC EVENT 5 ----- " + pair.trackedReserveETH.toString(), [])
      // reset factory liquidity by subtracting onluy tarcked liquidity
      teleswap.totalLiquidityETH = teleswap.totalLiquidityETH.minus(pair.trackedReserveETH as BigDecimal)


      log.debug("SYNC EVENT 6 ----- reserve0: " + pair.reserve0.toString(), [])
      // reset token total liquidity amounts
      if (token0.totalLiquidity)
        token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)

      log.debug("SYNC EVENT 7 ----- reserve1: " + pair.reserve1.toString(), [])
      if (token1.totalLiquidity)
        token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

      log.debug("SYNC EVENT 8 ----- decimals0: " + token0.decimals.toString(), [])
      if (token0.decimals)
        pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)

      log.debug("SYNC EVENT 9 ----- decimals1: " + token1.decimals.toString(), [])
      if (token1.decimals)
        pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)

      log.debug("SYNC EVENT 10 ----- token0Price: " + pair.reserve0.div(pair.reserve1).toString(), [])
      if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1)
      else pair.token0Price = ZERO_BD
      log.debug("SYNC EVENT 11 ----- token1Price: " + pair.reserve1.div(pair.reserve0).toString(), [])
      if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0)
      else pair.token1Price = ZERO_BD

      pair.save()

      // update ETH price now that reserves could have changed
      let bundle = Bundle.load('1')
      if (bundle) {
        log.debug("SYNC EVENT 12 ----- bundleEthPrice: " + getEthPriceInUSD().toString(), [])
        bundle.ethPrice = getEthPriceInUSD()
        bundle.save()

        token0.derivedETH = findEthPerToken(token0 as Token)
        token1.derivedETH = findEthPerToken(token1 as Token)
        token0.save()
        token1.save()


        // get tracked liquidity - will be 0 if neither is in whitelist
        let trackedLiquidityETH: BigDecimal
        if (bundle.ethPrice.notEqual(ZERO_BD)) {
          trackedLiquidityETH = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(
            bundle.ethPrice
          )
          log.debug("SYNC EVENT 13 ----- trackedLiquidityETH: " + trackedLiquidityETH.toString(), [])
        } else {
          trackedLiquidityETH = ZERO_BD
        }

        // use derived amounts within pair
        pair.trackedReserveETH = trackedLiquidityETH
        pair.reserveETH = pair.reserve0
          .times(token0.derivedETH as BigDecimal)
          .plus(pair.reserve1.times(token1.derivedETH as BigDecimal))
        pair.reserveUSD = pair.reserveETH.times(bundle.ethPrice)

        // use tracked amounts globally
        teleswap.totalLiquidityETH = teleswap.totalLiquidityETH.plus(trackedLiquidityETH)
        teleswap.totalLiquidityUSD = teleswap.totalLiquidityETH.times(bundle.ethPrice)
      }
      // now correctly set liquidity amounts for each token
      if (token0.totalLiquidity)
        token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0)
      if (token1.totalLiquidity)
        token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1)

      // save entities
      pair.save()
      teleswap.save()
      token0.save()
      token1.save()
    }
  }
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  let mints = transaction ? (transaction.mints) : []
  if (!mints)
    mints = []
  let mint = MintEvent.load(mints[mints.length - 1])

  let pair = Pair.load(event.address.toHex())
  let teleswap = TeleswapFactory.load(FACTORY_ADDRESS)
  if (pair && teleswap && mint) {
    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    if (token0 && token1 && token0.decimals && token1.decimals) {
      // update exchange info (except balances, sync will cover that)
      let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
      let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

      // update txn counts
      if (token0.txCount)
        token0.txCount = token0.txCount.plus(ONE_BI)
      if (token1.txCount)
        token1.txCount = token1.txCount.plus(ONE_BI)

      // get new amounts of USD and ETH for tracking
      let bundle = Bundle.load('1')
      let tkn1dreth = token1.derivedETH
      let tkn0dreth = token0.derivedETH
      if (tkn0dreth && tkn1dreth) {
        let amountTotalUSD = bundle ? tkn1dreth.times(token1Amount)
          .plus(tkn0dreth.times(token0Amount))
          .times(bundle.ethPrice) : null

        // update txn counts
        pair.txCount = pair.txCount.plus(ONE_BI)
        teleswap.txCount = teleswap.txCount.plus(ONE_BI)

        // save entities
        token0.save()
        token1.save()
        pair.save()
        teleswap.save()
        mint.sender = event.params.sender
        mint.amount0 = token0Amount as BigDecimal
        mint.amount1 = token1Amount as BigDecimal
        mint.logIndex = event.logIndex
        mint.amountUSD = amountTotalUSD as BigDecimal
        mint.save()
      }
    }

    // update the LP position
    let liquidityPosition = createLiquidityPosition(event.address, Address.fromBytes(mint.to))
    createLiquiditySnapshot(liquidityPosition, event)

    // update day entities
    updatePairDayData(event)
    updatePairHourData(event)
    updateTeleswapDayData(event)
    updateTokenDayData(token0 as Token, event)
    updateTokenDayData(token1 as Token, event)
  }
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  let burns = transaction.burns
  if (!burns)
    burns = []
  let burn = BurnEvent.load(burns[burns.length - 1])

  let pair = Pair.load(event.address.toHex())
  let teleswap = TeleswapFactory.load(FACTORY_ADDRESS)
  if (pair && teleswap && burn) {
    //update token info
    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    if (token0 && token1 && token0.decimals && token1.decimals) {
      let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
      let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

      // update txn counts
      if (token0.txCount)
        token0.txCount = token0.txCount.plus(ONE_BI)
      if (token1.txCount)
        token1.txCount = token1.txCount.plus(ONE_BI)

      // get new amounts of USD and ETH for tracking
      let bundle = Bundle.load('1')
      let tkn1dreth = token1.derivedETH
      let tkn0dreth = token0.derivedETH
      if (tkn1dreth && tkn0dreth && bundle) {
        let amountTotalUSD = tkn1dreth.times(token1Amount)
          .plus(tkn0dreth.times(token0Amount))
          .times(bundle.ethPrice)

        // update txn counts
        teleswap.txCount = teleswap.txCount.plus(ONE_BI)
        pair.txCount = pair.txCount.plus(ONE_BI)

        // update global counter and save
        token0.save()
        token1.save()
        pair.save()
        teleswap.save()

        // update burn
        // burn.sender = event.params.sender
        burn.amount0 = token0Amount as BigDecimal
        burn.amount1 = token1Amount as BigDecimal
        // burn.to = event.params.to
        burn.logIndex = event.logIndex
        burn.amountUSD = amountTotalUSD as BigDecimal
        burn.save()
      }
      // update the LP position
      const burnSender = burn.sender
      if (burnSender) {
        let liquidityPosition = createLiquidityPosition(event.address, Address.fromBytes(burnSender))
        createLiquiditySnapshot(liquidityPosition, event)
      }

      // update day entities
      updatePairDayData(event)
      updatePairHourData(event)
      updateTeleswapDayData(event)
      updateTokenDayData(token0 as Token, event)
      updateTokenDayData(token1 as Token, event)
    }
  }
}

export function handleSwap(event: Swap): void {
  log.info('SWAP EVENT ----- {} {} {} {}', [
    event.params.amount0In.toString(),
    event.params.amount1In.toString(),
    event.params.amount0Out.toString(),
    event.params.amount1Out.toString(),
  ])
  let pair = Pair.load(event.address.toHexString())
  if (pair) {
    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    if (token0 && token1 && token0.decimals && token1.decimals) {
      let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
      let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
      let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
      let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

      // totals for volume updates
      let amount0Total = amount0Out.plus(amount0In)
      let amount1Total = amount1Out.plus(amount1In)

      // ETH/USD prices
      let bundle = Bundle.load('1')

      // get total amounts of derived USD and ETH for tracking
      let tkn1dreth = token1.derivedETH
      let tkn0dreth = token0.derivedETH
      if (tkn1dreth && tkn0dreth && bundle) {
        let derivedAmountETH = tkn1dreth.times(amount1Total)
          .plus(tkn0dreth.times(amount0Total))
          .div(BigDecimal.fromString('2'))
        let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)

        // only accounts for volume through white listed tokens
        let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0 as Token, amount1Total, token1 as Token, pair as Pair)

        let trackedAmountETH: BigDecimal
        if (bundle && bundle.ethPrice.equals(ZERO_BD)) {
          trackedAmountETH = ZERO_BD
        } else if (bundle) {
          trackedAmountETH = trackedAmountUSD.div(bundle.ethPrice)
        } else {
          trackedAmountETH = ZERO_BD
        }

        // update token0 global volume and token liquidity stats
        if (token0.tradeVolume)
          token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
        if (token0.tradeVolumeUSD)
          token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
        if (derivedAmountUSD && token0.untrackedVolumeUSD)
          token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

        // update token1 global volume and token liquidity stats
        if (token1.tradeVolume)
          token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
        if (token1.tradeVolumeUSD)
          token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
        if (derivedAmountUSD && token1.untrackedVolumeUSD)
          token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

        // update txn counts
        if (token0.txCount)
          token0.txCount = token0.txCount.plus(ONE_BI)
        if (token1.txCount)
          token1.txCount = token1.txCount.plus(ONE_BI)

        // update pair volume data, use tracked amount if we have it as its probably more accurate
        pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
        pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
        pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
        if (derivedAmountUSD)
          pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
        pair.txCount = pair.txCount.plus(ONE_BI)
        pair.save()

        // update global values, only used tracked amounts for volume
        let teleswap = TeleswapFactory.load(FACTORY_ADDRESS)
        if (teleswap) {
          teleswap.totalVolumeUSD = teleswap.totalVolumeUSD.plus(trackedAmountUSD)
          teleswap.totalVolumeETH = teleswap.totalVolumeETH.plus(trackedAmountETH)
          if (derivedAmountUSD)
            teleswap.untrackedVolumeUSD = teleswap.untrackedVolumeUSD.plus(derivedAmountUSD)
          teleswap.txCount = teleswap.txCount.plus(ONE_BI)

          // save entities
          pair.save()
          token0.save()
          token1.save()
          teleswap.save()
        }
        let transaction = Transaction.load(event.transaction.hash.toHexString())
        if (transaction === null) {
          transaction = new Transaction(event.transaction.hash.toHexString())
          transaction.blockNumber = event.block.number
          transaction.timestamp = event.block.timestamp
          transaction.mints = []
          transaction.swaps = []
          transaction.burns = []
        }
        let swaps = transaction.swaps
        if (!swaps)
          swaps = []
        let swap = new SwapEvent(
          event.transaction.hash
            .toHexString()
            .concat('-')
            .concat(BigInt.fromI32(swaps.length).toString())
        )

        // update swap event
        swap.transaction = transaction.id
        swap.pair = pair.id
        swap.timestamp = transaction.timestamp
        swap.transaction = transaction.id
        swap.sender = event.params.sender
        swap.amount0In = amount0In
        swap.amount1In = amount1In
        swap.amount0Out = amount0Out
        swap.amount1Out = amount1Out
        swap.to = event.params.to
        swap.from = event.transaction.from
        swap.logIndex = event.logIndex
        // use the tracked amount if we have it
        swap.amountUSD = derivedAmountUSD ? (trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD) : ZERO_BD;
        swap.save()

        // update the transaction

        // TODO: Consider using .concat() for handling array updates to protect
        // against unintended side effects for other code paths.
        swaps.push(swap.id)
        transaction.swaps = swaps
        transaction.save()

        // update day entities
        let pairDayData = updatePairDayData(event)
        let pairHourData = updatePairHourData(event)
        let teleswapDayData = updateTeleswapDayData(event)
        let token0DayData = updateTokenDayData(token0 as Token, event)
        let token1DayData = updateTokenDayData(token1 as Token, event)

        // swap specific updating
        teleswapDayData.dailyVolumeUSD = teleswapDayData.dailyVolumeUSD.plus(trackedAmountUSD)
        teleswapDayData.dailyVolumeETH = teleswapDayData.dailyVolumeETH.plus(trackedAmountETH)
        teleswapDayData.dailyVolumeUntracked = derivedAmountUSD ? teleswapDayData.dailyVolumeUntracked.plus(derivedAmountUSD) : ZERO_BD
        teleswapDayData.save()

        // swap specific updating for pair
        pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
        pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
        pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
        pairDayData.save()

        // update hourly pair data
        pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
        pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
        pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
        pairHourData.save()

        // swap specific updating for token0
        token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
        token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(amount0Total.times(token0.derivedETH as BigDecimal))
        token0DayData.dailyVolumeUSD = bundle ? token0DayData.dailyVolumeUSD.plus(
          amount0Total.times(token0.derivedETH as BigDecimal).times(bundle.ethPrice)
        ) : ZERO_BD;
        token0DayData.save()

        // swap specific updating
        token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
        token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(amount1Total.times(token1.derivedETH as BigDecimal))
        token1DayData.dailyVolumeUSD = bundle ? token1DayData.dailyVolumeUSD.plus(
          amount1Total.times(token1.derivedETH as BigDecimal).times(bundle.ethPrice)
        ) : ZERO_BD;
        token1DayData.save()
      }
    }
  }
}
