/*

  Copyright 2018 ZeroEx Intl.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

*/

pragma solidity 0.4.24;
pragma experimental ABIEncoderV2;

import "../../protocol/Exchange/libs/LibOrder.sol";
import "../../protocol/Exchange/libs/LibFillResults.sol";
import "../../protocol/Exchange/libs/LibAbiEncoder.sol";
import "../../utils/Ownable/Ownable.sol";
import "./LibConstants.sol";


contract MixinMatchOrders is
    Ownable,
    LibAbiEncoder,
    LibConstants
{
    /// @dev Match two complementary orders that have a profitable spread.
    ///      Each order is filled at their respective price point. However, the calculations are
    ///      carried out as though the orders are both being filled at the right order's price point.
    ///      The profit made by the left order is then used to fill the right order as much as possible.
    ///      This results in a spread being taken in terms of both assets. The spread is held within this contract.
    /// @param leftOrder First order to match.
    /// @param rightOrder Second order to match.
    /// @param leftSignature Proof that order was created by the left maker.
    /// @param rightSignature Proof that order was created by the right maker.
    function matchOrders(
        LibOrder.Order memory leftOrder,
        LibOrder.Order memory rightOrder,
        bytes memory leftSignature,
        bytes memory rightSignature
    )
        public
        onlyOwner
    {
        // We assume that rightOrder.takerAssetData == leftOrder.makerAssetData and rightOrder.makerAssetData == leftOrder.takerAssetData.
        // If this assumption isn't true, the match will fail at signature validation.
        rightOrder.makerAssetData = leftOrder.takerAssetData;
        rightOrder.takerAssetData = leftOrder.makerAssetData;

        // Match orders, maximally filling `leftOrder`
        // TODO: optimize by manually ABI encoding `matchOrders`
        LibFillResults.MatchedFillResults memory matchedFillResults = EXCHANGE.matchOrders(
            leftOrder,
            rightOrder,
            leftSignature,
            rightSignature
        );

        // If a spread was taken, use the spread to fill remaining amount of `rightOrder`
        uint256 leftMakerAssetSpreadAmount = matchedFillResults.leftMakerAssetSpreadAmount;
        // TODO: Do we need to check if `rightOrder` is completely filled?
        if (leftMakerAssetSpreadAmount > 0) {
            // We do not need to pass in a signature since it was already validated in the `matchOrders` call
            bytes memory fillOrderCalldata = abiEncodeFillOrder(
                rightOrder,
                leftMakerAssetSpreadAmount,
                ""
            );

            address exchange = address(EXCHANGE);
            assembly {
                // Call `fillOrder`
                let success := call(
                    gas,                                // forward all gas
                    exchange,                           // call address of Exchange contract
                    0,                                  // transfer 0 wei
                    add(fillOrderCalldata, 32),         // pointer to start of input (skip array length in first 32 bytes)
                    mload(fillOrderCalldata),           // length of input
                    fillOrderCalldata,                  // write output over input
                    128                                 // output size is 128 bytes
                )
                // Revert with reason if `fillOrder` call is unsuccessful
                if iszero(success) {
                    revert(fillOrderCalldata, returndatasize())
                }
            }
        }
    }
}
