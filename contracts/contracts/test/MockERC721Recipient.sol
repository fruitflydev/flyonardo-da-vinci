// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only ERC-721 receivers. Each one covers a branch of _checkReceiver.
contract MockERC721Recipient {
    address public lastOperator;
    address public lastFrom;
    uint256 public lastTokenId;
    bytes public lastData;
    uint256 public calls;

    event Received(address operator, address from, uint256 tokenId, bytes data);

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        lastOperator = operator;
        lastFrom = from;
        lastTokenId = tokenId;
        lastData = data;
        calls += 1;
        emit Received(operator, from, tokenId, data);
        return this.onERC721Received.selector;
    }
}

/// @notice Implements the hook but answers with the wrong magic value.
contract MockWrongMagicRecipient {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @notice Reverts with a reason string; the reason must reach the caller unchanged.
contract MockRevertingRecipient {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("no thanks");
    }
}

/// @notice Reverts with no data at all, which has to surface as UnsafeRecipient.
contract MockSilentRevertRecipient {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert();
    }
}

/// @notice Returns 4 bytes instead of an ABI-encoded bytes4 - too short to be a valid answer.
contract MockShortReturnRecipient {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        assembly {
            mstore(0, 0x150b7a0200000000000000000000000000000000000000000000000000000000)
            return(0, 4)
        }
    }
}

/// @notice A contract with no hook at all: safeTransferFrom into it must revert.
contract MockNonReceiver {
    uint256 public x;

    function poke() external {
        x += 1;
    }
}
