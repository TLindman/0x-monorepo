import { BlockchainLifecycle } from '@0xproject/dev-utils';
import { assetDataUtils } from '@0xproject/order-utils';
import { RevertReason } from '@0xproject/types';
import { BigNumber } from '@0xproject/utils';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import * as chai from 'chai';
import * as _ from 'lodash';

import { DummyERC20TokenContract } from '../../generated_contract_wrappers/dummy_erc20_token';
import { ERC20ProxyContract } from '../../generated_contract_wrappers/erc20_proxy';
import { ERC721ProxyContract } from '../../generated_contract_wrappers/erc721_proxy';
import { ExchangeContract } from '../../generated_contract_wrappers/exchange';
import { OrderMatcherContract } from '../../generated_contract_wrappers/order_matcher';
import { artifacts } from '../utils/artifacts';
import { expectTransactionFailedAsync } from '../utils/assertions';
import { chaiSetup } from '../utils/chai_setup';
import { constants } from '../utils/constants';
import { ERC20Wrapper } from '../utils/erc20_wrapper';
import { ExchangeWrapper } from '../utils/exchange_wrapper';
import { OrderFactory } from '../utils/order_factory';
import { ERC20BalancesByOwner } from '../utils/types';
import { provider, txDefaults, web3Wrapper } from '../utils/web3_wrapper';

const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);
chaiSetup.configure();
const expect = chai.expect;

describe('OrderMatcher', () => {
    let makerAddressLeft: string;
    let makerAddressRight: string;
    let owner: string;
    let takerAddress: string;
    let feeRecipientAddressLeft: string;
    let feeRecipientAddressRight: string;

    let erc20TokenA: DummyERC20TokenContract;
    let erc20TokenB: DummyERC20TokenContract;
    let zrxToken: DummyERC20TokenContract;
    let exchange: ExchangeContract;
    let erc20Proxy: ERC20ProxyContract;
    let erc721Proxy: ERC721ProxyContract;
    let orderMatcher: OrderMatcherContract;

    let erc20BalancesByOwner: ERC20BalancesByOwner;
    let exchangeWrapper: ExchangeWrapper;
    let erc20Wrapper: ERC20Wrapper;
    let orderFactoryLeft: OrderFactory;
    let orderFactoryRight: OrderFactory;

    let defaultERC20MakerAssetAddress: string;
    let defaultERC20TakerAssetAddress: string;

    before(async () => {
        await blockchainLifecycle.startAsync();
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
    });
    before(async () => {
        // Create accounts
        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        // Hack(albrow): Both Prettier and TSLint insert a trailing comma below
        // but that is invalid syntax as of TypeScript version >= 2.8. We don't
        // have the right fine-grained configuration options in TSLint,
        // Prettier, or TypeScript, to reconcile this, so we will just have to
        // wait for them to sort it out. We disable TSLint and Prettier for
        // this part of the code for now. This occurs several times in this
        // file. See https://github.com/prettier/prettier/issues/4624.
        // prettier-ignore
        const usedAddresses = ([
            owner,
            makerAddressLeft,
            makerAddressRight,
            takerAddress,
            feeRecipientAddressLeft,
            // tslint:disable-next-line:trailing-comma
            feeRecipientAddressRight
        ] = _.slice(accounts, 0, 6));
        // Create wrappers
        erc20Wrapper = new ERC20Wrapper(provider, usedAddresses, owner);
        // Deploy ERC20 token & ERC20 proxy
        const numDummyErc20ToDeploy = 3;
        [erc20TokenA, erc20TokenB, zrxToken] = await erc20Wrapper.deployDummyTokensAsync(
            numDummyErc20ToDeploy,
            constants.DUMMY_TOKEN_DECIMALS,
        );
        erc20Proxy = await erc20Wrapper.deployProxyAsync();
        await erc20Wrapper.setBalancesAndAllowancesAsync();
        // Deploy ERC721 proxy
        erc721Proxy = await ERC721ProxyContract.deployFrom0xArtifactAsync(artifacts.ERC721Proxy, provider, txDefaults);
        // Depoy exchange
        exchange = await ExchangeContract.deployFrom0xArtifactAsync(
            artifacts.Exchange,
            provider,
            txDefaults,
            assetDataUtils.encodeERC20AssetData(zrxToken.address),
        );
        exchangeWrapper = new ExchangeWrapper(exchange, provider);
        await exchangeWrapper.registerAssetProxyAsync(erc20Proxy.address, owner);
        await exchangeWrapper.registerAssetProxyAsync(erc721Proxy.address, owner);
        // Authorize ERC20 trades by exchange
        await web3Wrapper.awaitTransactionSuccessAsync(
            await erc20Proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
                from: owner,
            }),
            constants.AWAIT_TRANSACTION_MINED_MS,
        );
        // Deploy OrderMatcher
        orderMatcher = await OrderMatcherContract.deployFrom0xArtifactAsync(
            artifacts.OrderMatcher,
            provider,
            txDefaults,
            exchange.address,
        );
        // Set default addresses
        defaultERC20MakerAssetAddress = erc20TokenA.address;
        defaultERC20TakerAssetAddress = erc20TokenB.address;
        const leftMakerAssetData = assetDataUtils.encodeERC20AssetData(defaultERC20MakerAssetAddress);
        const leftTakerAssetData = assetDataUtils.encodeERC20AssetData(defaultERC20TakerAssetAddress);
        // Set OrderMatcher allowances
        await web3Wrapper.awaitTransactionSuccessAsync(
            await orderMatcher.approveAssetProxy.sendTransactionAsync(
                leftMakerAssetData,
                constants.INITIAL_ERC20_ALLOWANCE,
            ),
            constants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await orderMatcher.approveAssetProxy.sendTransactionAsync(
                leftTakerAssetData,
                constants.INITIAL_ERC20_ALLOWANCE,
            ),
            constants.AWAIT_TRANSACTION_MINED_MS,
        );
        // Create default order parameters
        const defaultOrderParamsLeft = {
            ...constants.STATIC_ORDER_PARAMS,
            makerAddress: makerAddressLeft,
            exchangeAddress: exchange.address,
            makerAssetData: leftMakerAssetData,
            takerAssetData: leftTakerAssetData,
            feeRecipientAddress: feeRecipientAddressLeft,
            makerFee: constants.ZERO_AMOUNT,
            takerFee: constants.ZERO_AMOUNT,
        };
        const defaultOrderParamsRight = {
            ...constants.STATIC_ORDER_PARAMS,
            makerAddress: makerAddressRight,
            exchangeAddress: exchange.address,
            makerAssetData: assetDataUtils.encodeERC20AssetData(defaultERC20TakerAssetAddress),
            takerAssetData: assetDataUtils.encodeERC20AssetData(defaultERC20MakerAssetAddress),
            feeRecipientAddress: feeRecipientAddressRight,
            makerFee: constants.ZERO_AMOUNT,
            takerFee: constants.ZERO_AMOUNT,
        };
        const privateKeyLeft = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddressLeft)];
        orderFactoryLeft = new OrderFactory(privateKeyLeft, defaultOrderParamsLeft);
        const privateKeyRight = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddressRight)];
        orderFactoryRight = new OrderFactory(privateKeyRight, defaultOrderParamsRight);
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });
    describe('matchOrders', () => {
        beforeEach(async () => {
            erc20BalancesByOwner = await erc20Wrapper.getBalancesAsync();
        });
        it('should transfer the correct amounts when orders completely fill each other', async () => {
            // Create orders to match
            const signedOrderLeft = await orderFactoryLeft.newSignedOrderAsync({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(5), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(10), 18),
            });
            const signedOrderRight = await orderFactoryRight.newSignedOrderAsync({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(10), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(2), 18),
            });
            // Match signedOrderLeft with signedOrderRight
            const expectedTransferAmounts = {
                // Left Maker
                amountSoldByLeftMaker: signedOrderLeft.makerAssetAmount,
                amountBoughtByLeftMaker: signedOrderLeft.takerAssetAmount,
                // Right Maker
                amountSoldByRightMaker: signedOrderRight.makerAssetAmount,
                amountBoughtByRightMaker: signedOrderRight.takerAssetAmount,
                // Taker
                leftMakerAssetSpreadAmount: signedOrderLeft.makerAssetAmount.minus(signedOrderRight.takerAssetAmount),
            };
            const initialLeftMakerAssetTakerBalance = await erc20TokenA.balanceOf.callAsync(orderMatcher.address);
            await web3Wrapper.awaitTransactionSuccessAsync(
                await orderMatcher.matchOrders.sendTransactionAsync(
                    signedOrderLeft,
                    signedOrderRight,
                    signedOrderLeft.signature,
                    signedOrderRight.signature,
                ),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );
            const newLeftMakerAssetTakerBalance = await erc20TokenA.balanceOf.callAsync(orderMatcher.address);
            const newErc20Balances = await erc20Wrapper.getBalancesAsync();
            expect(newErc20Balances[makerAddressLeft][defaultERC20MakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressLeft][defaultERC20MakerAssetAddress].minus(
                    expectedTransferAmounts.amountSoldByLeftMaker,
                ),
            );
            expect(newErc20Balances[makerAddressRight][defaultERC20TakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressRight][defaultERC20TakerAssetAddress].minus(
                    expectedTransferAmounts.amountSoldByRightMaker,
                ),
            );
            expect(newErc20Balances[makerAddressLeft][defaultERC20TakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressLeft][defaultERC20TakerAssetAddress].plus(
                    expectedTransferAmounts.amountBoughtByLeftMaker,
                ),
            );
            expect(newErc20Balances[makerAddressRight][defaultERC20MakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressRight][defaultERC20MakerAssetAddress].plus(
                    expectedTransferAmounts.amountBoughtByRightMaker,
                ),
            );
            expect(newLeftMakerAssetTakerBalance).to.be.bignumber.equal(
                initialLeftMakerAssetTakerBalance.plus(expectedTransferAmounts.leftMakerAssetSpreadAmount),
            );
        });
        it('should transfer the correct amounts when orders completely fill each other and taker doesnt take a profit', async () => {
            // Create orders to match
            const signedOrderLeft = await orderFactoryLeft.newSignedOrderAsync({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(5), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(10), 18),
            });
            const signedOrderRight = await orderFactoryRight.newSignedOrderAsync({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(10), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(5), 18),
            });
            // Match signedOrderLeft with signedOrderRight
            const expectedTransferAmounts = {
                // Left Maker
                amountSoldByLeftMaker: signedOrderLeft.makerAssetAmount,
                amountBoughtByLeftMaker: signedOrderLeft.takerAssetAmount,
                // Right Maker
                amountSoldByRightMaker: signedOrderRight.makerAssetAmount,
                amountBoughtByRightMaker: signedOrderRight.takerAssetAmount,
            };
            const initialLeftMakerAssetTakerBalance = await erc20TokenA.balanceOf.callAsync(orderMatcher.address);
            await web3Wrapper.awaitTransactionSuccessAsync(
                await orderMatcher.matchOrders.sendTransactionAsync(
                    signedOrderLeft,
                    signedOrderRight,
                    signedOrderLeft.signature,
                    signedOrderRight.signature,
                ),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );
            const newLeftMakerAssetTakerBalance = await erc20TokenA.balanceOf.callAsync(orderMatcher.address);
            const newErc20Balances = await erc20Wrapper.getBalancesAsync();
            expect(newErc20Balances[makerAddressLeft][defaultERC20MakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressLeft][defaultERC20MakerAssetAddress].minus(
                    expectedTransferAmounts.amountSoldByLeftMaker,
                ),
            );
            expect(newErc20Balances[makerAddressRight][defaultERC20TakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressRight][defaultERC20TakerAssetAddress].minus(
                    expectedTransferAmounts.amountSoldByRightMaker,
                ),
            );
            expect(newErc20Balances[makerAddressLeft][defaultERC20TakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressLeft][defaultERC20TakerAssetAddress].plus(
                    expectedTransferAmounts.amountBoughtByLeftMaker,
                ),
            );
            expect(newErc20Balances[makerAddressRight][defaultERC20MakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressRight][defaultERC20MakerAssetAddress].plus(
                    expectedTransferAmounts.amountBoughtByRightMaker,
                ),
            );
            expect(newLeftMakerAssetTakerBalance).to.be.bignumber.equal(initialLeftMakerAssetTakerBalance);
        });
        it('should transfer the correct amounts when left order is completely filled and right order would be partially filled', async () => {
            // Create orders to match
            const signedOrderLeft = await orderFactoryLeft.newSignedOrderAsync({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(5), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(10), 18),
            });
            const signedOrderRight = await orderFactoryRight.newSignedOrderAsync({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(20), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(4), 18),
            });
            // Match signedOrderLeft with signedOrderRight
            const expectedTransferAmounts = {
                // Left Maker
                amountSoldByLeftMaker: signedOrderLeft.makerAssetAmount,
                amountBoughtByLeftMaker: signedOrderLeft.takerAssetAmount,
                // Right Maker
                amountSoldByRightMaker: signedOrderRight.makerAssetAmount,
                amountBoughtByRightMaker: signedOrderRight.takerAssetAmount,
                // Taker
                leftMakerAssetSpreadAmount: signedOrderLeft.makerAssetAmount.minus(signedOrderRight.takerAssetAmount),
                leftTakerAssetSpreadAmount: signedOrderRight.makerAssetAmount.minus(signedOrderLeft.takerAssetAmount),
            };
            const initialLeftMakerAssetTakerBalance = await erc20TokenA.balanceOf.callAsync(orderMatcher.address);
            const initialLeftTakerAssetTakerBalance = await erc20TokenB.balanceOf.callAsync(orderMatcher.address);
            // Match signedOrderLeft with signedOrderRight
            await web3Wrapper.awaitTransactionSuccessAsync(
                await orderMatcher.matchOrders.sendTransactionAsync(
                    signedOrderLeft,
                    signedOrderRight,
                    signedOrderLeft.signature,
                    signedOrderRight.signature,
                ),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );
            const newLeftMakerAssetTakerBalance = await erc20TokenA.balanceOf.callAsync(orderMatcher.address);
            const newLeftTakerAssetTakerBalance = await erc20TokenB.balanceOf.callAsync(orderMatcher.address);
            const newErc20Balances = await erc20Wrapper.getBalancesAsync();
            expect(newErc20Balances[makerAddressLeft][defaultERC20MakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressLeft][defaultERC20MakerAssetAddress].minus(
                    expectedTransferAmounts.amountSoldByLeftMaker,
                ),
            );
            expect(newErc20Balances[makerAddressRight][defaultERC20TakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressRight][defaultERC20TakerAssetAddress].minus(
                    expectedTransferAmounts.amountSoldByRightMaker,
                ),
            );
            expect(newErc20Balances[makerAddressLeft][defaultERC20TakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressLeft][defaultERC20TakerAssetAddress].plus(
                    expectedTransferAmounts.amountBoughtByLeftMaker,
                ),
            );
            expect(newErc20Balances[makerAddressRight][defaultERC20MakerAssetAddress]).to.be.bignumber.equal(
                erc20BalancesByOwner[makerAddressRight][defaultERC20MakerAssetAddress].plus(
                    expectedTransferAmounts.amountBoughtByRightMaker,
                ),
            );
            expect(newLeftMakerAssetTakerBalance).to.be.bignumber.equal(
                initialLeftMakerAssetTakerBalance.plus(expectedTransferAmounts.leftMakerAssetSpreadAmount),
            );
            expect(newLeftTakerAssetTakerBalance).to.be.bignumber.equal(
                initialLeftTakerAssetTakerBalance.plus(expectedTransferAmounts.leftTakerAssetSpreadAmount),
            );
        });
    });
});
