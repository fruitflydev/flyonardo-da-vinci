// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

/// @title Flyonardo da Vinci
/// @notice A simulated fruit-fly brain (165,122 real neurons) is driven by live Robinhood Chain
///         activity. Its descending neurons steer a fly that walks across a canvas leaving a
///         coloured line: the chain paints, through the fly.
///
///         This contract is the canvas ledger. The painter service (the `operator`) commits the
///         growing picture: `strokeRoot` hashes the stroke log so far, `inputHash` the chain inputs
///         that produced it. Anyone may `claim` the canvas they are looking at; the claim burns
///         $FLYBRAIN to 0x...dEaD, mints that canvas as an ERC-721, and freezes it at the LAST
///         COMMITTED values. The picture is pinned by the operator before a claim, never supplied
///         by the claimer, so nobody can choose the painting they are minting. A blank canvas then
///         begins and the fly keeps walking.
///
///         No payable functions, no withdrawals, no upgrades, no proxy. Only price, operator and
///         baseURI are mutable; a frozen canvas is frozen forever and tokens are never burned.
contract FlyonardoCanvas {
    // ---------------------------------------------------------------- constants

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Launch price, 100,000 $FLYBRAIN. A constant and not a constructor argument so a
    ///         fat-fingered deploy cannot mis-price the first canvas; setPrice moves it afterwards.
    uint256 public constant INITIAL_PRICE = 100_000e18;

    /// @notice Canvas ids (and therefore token ids) start at 1, leaving id 0 free to mean "no
    ///         canvas" in the painter, the site and every event consumer.
    uint64 public constant FIRST_CANVAS = 1;

    string public constant name = "Flyonardo da Vinci";
    string public constant symbol = "FLYONARDO";

    /// @notice The burn token ($FLYBRAIN), fixed at deploy: a canvas priced in one coin can never
    ///         be silently re-priced in another.
    address public immutable token;

    // ---------------------------------------------------------------- types

    /// @notice A canvas that has been claimed. Written once, in claim(), and never touched again.
    ///         commitBlock/commitTime are the painter's last commit before the claim - the block
    ///         that pins the picture - while claimBlock/claimTime are the claim itself.
    struct Canvas {
        bytes32 strokeRoot;   // slot 0
        bytes32 inputHash;    // slot 1
        uint32 strokes;       // slot 2, 4 bytes
        uint32 commits;       // slot 2, 4 bytes
        uint64 commitBlock;   // slot 2, 8 bytes
        uint32 commitTime;    // slot 2, 4 bytes, unix seconds, fits until 2106
        uint64 claimBlock;    // slot 2, 8 bytes
        uint32 claimTime;     // slot 2, 4 bytes -> 32 bytes exactly
        address claimer;      // slot 3, the address that burned; ownerOf() can move away from it
        uint256 burned;       // slot 4, price at claim time
    }

    // ---------------------------------------------------------------- storage

    // Storage is packed by hand. The live canvas sits in one slot together with the reentrancy
    // lock, so a commit writes three slots and claim's lock/unlock coalesces with the slot it has
    // to write anyway. Public getters are written out by hand where a field is packed.
    address public owner;          // slot 0 (20 bytes)
    address public operator;       // slot 1 (20 bytes)
    uint256 public price;          // slot 2
    string private _baseURI;       // slot 3

    uint64 private _cur;           // slot 4 (8 bytes), the canvas being painted right now
    uint32 private _liveStrokes;   // slot 4 (4 bytes)
    uint32 private _liveCommits;   // slot 4 (4 bytes), 0 = nothing committed for this canvas yet
    uint64 private _liveBlock;     // slot 4 (8 bytes)
    uint32 private _liveTime;      // slot 4 (4 bytes), unix seconds
    uint8 private _lock;           // slot 4 (1 byte), reentrancy lock -> 29 bytes used

    bytes32 private _liveRoot;     // slot 5
    bytes32 private _liveInput;    // slot 6

    mapping(uint64 => Canvas) private _canvas;                       // slot 7
    mapping(uint256 => address) private _owners;                     // slot 8
    mapping(address => uint256) private _balances;                   // slot 9
    mapping(uint256 => address) private _approvals;                  // slot 10
    mapping(address => mapping(address => bool)) private _operators; // slot 11

    // ---------------------------------------------------------------- events

    event Committed(uint64 indexed canvasId, uint32 strokes, bytes32 strokeRoot, bytes32 inputHash, uint32 commits);
    event Claimed(uint64 indexed canvasId, address indexed claimer, uint256 burned, bytes32 strokeRoot, bytes32 inputHash, uint32 strokes, uint32 commits, uint64 commitBlock);
    event CanvasStarted(uint64 indexed canvasId);
    event PriceSet(uint256 price);
    event OperatorSet(address operator);
    event OwnerSet(address owner);
    event BaseURISet(string baseURI);

    // ERC-721
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error NotAContract();
    error ZeroPrice();
    error Reentrancy();
    error NotCurrentCanvas(uint64 current);
    error StrokesDecreased(uint32 committed, uint32 given);
    error NothingCommitted();
    error PriceAboveMax(uint256 price, uint256 maxBurn);
    error TransferFailed();
    error BurnMismatch(uint256 expected, uint256 received);
    error NotFrozen();
    error NoSuchToken();
    error WrongFrom(address owner);
    error NotAuthorized();
    error UnsafeRecipient(address to);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_, address operator_) {
        if (token_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert NotAContract();
        token = token_;
        owner = msg.sender;
        operator = operator_;
        price = INITIAL_PRICE;
        _cur = FIRST_CANVAS;
        emit OwnerSet(msg.sender);
        emit OperatorSet(operator_);
        emit PriceSet(INITIAL_PRICE);
        emit CanvasStarted(FIRST_CANVAS);
    }

    // ---------------------------------------------------------------- owner

    function setPrice(uint256 price_) external onlyOwner {
        if (price_ == 0) revert ZeroPrice();
        price = price_;
        emit PriceSet(price_);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Metadata prefix for tokenURI. The frozen record on chain is the artwork's proof;
    ///         baseURI only points at how it is rendered, so it stays movable.
    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        owner = to;
        emit OwnerSet(to);
    }

    // ---------------------------------------------------------------- painting

    /// @notice Records the state of the canvas being painted. The painter calls this once per
    ///         12-second window, but the window is deliberately NOT enforced on chain: a commit
    ///         dropped by the mempool has to be able to land immediately after, and a chain with
    ///         ~0.1s blocks gives no useful timestamp granularity to police it with. What is
    ///         enforced is what a claimer depends on: the id, and that the picture only ever grows.
    /// @param canvasId Must be the canvas being painted now; a commit can never reach a frozen one.
    /// @param strokeRoot Hash over the stroke log so far.
    /// @param inputHash Hash over the chain inputs that produced those strokes.
    /// @param strokes Total strokes on the canvas so far. May repeat (a window where the fly stood
    ///        still still carries fresh chain input) but may never go backwards.
    function commit(uint64 canvasId, bytes32 strokeRoot, bytes32 inputHash, uint32 strokes) external {
        if (msg.sender != operator) revert NotOperator();
        uint64 id = _cur;
        if (canvasId != id) revert NotCurrentCanvas(id);
        uint32 have = _liveStrokes;
        if (strokes < have) revert StrokesDecreased(have, strokes);

        _liveRoot = strokeRoot;
        _liveInput = inputHash;
        _liveStrokes = strokes;
        uint32 commits = _liveCommits + 1;
        _liveCommits = commits;
        _liveBlock = uint64(block.number);
        _liveTime = uint32(block.timestamp);
        emit Committed(id, strokes, strokeRoot, inputHash, commits);
    }

    /// @notice Burns `price` $FLYBRAIN to 0x...dEaD, mints canvas `canvasId` to the caller, and
    ///         freezes it at the last committed values. Every frozen field comes from storage the
    ///         operator wrote before this call: a claimer picks the moment, never the picture.
    /// @param canvasId Must equal the current canvas - you claim the canvas you were shown, not a
    ///        future one, and a claim can never race a claim that came first.
    /// @param maxBurn The most the caller agrees to burn (the price they were shown). Reverts if
    ///        the price was raised in between, so a standing allowance can never be overcharged.
    function claim(uint64 canvasId, uint256 maxBurn) external {
        if (_lock != 0) revert Reentrancy();
        uint64 id = _cur;
        if (canvasId != id) revert NotCurrentCanvas(id);
        uint32 commits = _liveCommits;
        if (commits == 0) revert NothingCommitted();
        uint256 amount = price;
        if (amount > maxBurn) revert PriceAboveMax(amount, maxBurn);

        // Snapshot the committed picture BEFORE the only external call in this function, so nothing
        // that happens inside the token's transferFrom - not even a commit from an operator that is
        // itself the token contract - can change what this claim freezes.
        bytes32 root = _liveRoot;
        bytes32 input = _liveInput;
        uint32 strokes = _liveStrokes;
        uint64 commitBlock = _liveBlock;
        uint32 commitTime = _liveTime;

        _lock = 1;
        _burn(amount);

        Canvas storage c = _canvas[id];
        c.strokeRoot = root;
        c.inputHash = input;
        c.strokes = strokes;
        c.commits = commits;
        c.commitBlock = commitBlock;
        c.commitTime = commitTime;
        c.claimBlock = uint64(block.number);
        c.claimTime = uint32(block.timestamp);
        c.claimer = msg.sender;
        c.burned = amount;

        // Mint without the onERC721Received hook: the recipient is msg.sender, who chose to be
        // here, and a hook would hand an unknown contract a callback in the middle of a freeze.
        _balances[msg.sender] += 1;
        _owners[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id);
        emit Claimed(id, msg.sender, amount, root, input, strokes, commits, commitBlock);

        // A blank canvas starts: same slot, so the reset and the unlock cost one write.
        uint64 next = id + 1;
        _cur = next;
        _liveRoot = bytes32(0);
        _liveInput = bytes32(0);
        _liveStrokes = 0;
        _liveCommits = 0;
        _liveBlock = 0;
        _liveTime = 0;
        _lock = 0;
        emit CanvasStarted(next);
    }

    /// @dev transferFrom(msg.sender, DEAD, amount); accepts empty return data or `true`, and
    ///      requires DEAD's balance to grow by exactly `amount` (rejects fee-on-transfer tokens).
    function _burn(uint256 amount) private {
        address t = token;
        uint256 before = IERC20(t).balanceOf(DEAD);
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, DEAD, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
        uint256 received = IERC20(t).balanceOf(DEAD) - before;
        if (received != amount) revert BurnMismatch(amount, received);
    }

    // ---------------------------------------------------------------- views

    /// @notice The canvas being painted right now and its last commit. commits == 0 means the
    ///         painter has not committed anything yet, and claim() would revert.
    function current()
        external
        view
        returns (uint64 canvasId, bytes32 strokeRoot, bytes32 inputHash, uint32 strokes, uint32 commits, uint64 commitBlock, uint32 commitTime)
    {
        return (_cur, _liveRoot, _liveInput, _liveStrokes, _liveCommits, _liveBlock, _liveTime);
    }

    function currentCanvas() external view returns (uint64) {
        return _cur;
    }

    /// @notice The frozen record of a claimed canvas. Reverts for the live canvas and for ids that
    ///         do not exist yet, so a caller can never mistake a zeroed struct for a painting.
    function canvasOf(uint64 canvasId) external view returns (Canvas memory) {
        Canvas memory c = _canvas[canvasId];
        if (c.claimer == address(0)) revert NotFrozen();
        return c;
    }

    /// @notice Canvases minted so far. Tokens are only ever minted by claim, ids run 1..n and are
    ///         never burned, so this is exact. ERC721Enumerable itself is not implemented.
    function totalSupply() external view returns (uint256) {
        return _cur - FIRST_CANVAS;
    }

    function baseURI() external view returns (string memory) {
        return _baseURI;
    }

    // ---------------------------------------------------------------- ERC-721

    function balanceOf(address holder) external view returns (uint256) {
        if (holder == address(0)) revert ZeroAddress();
        return _balances[holder];
    }

    function ownerOf(uint256 tokenId) public view returns (address holder) {
        holder = _owners[tokenId];
        if (holder == address(0)) revert NoSuchToken();
    }

    function approve(address to, uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        if (msg.sender != holder && !_operators[holder][msg.sender]) revert NotAuthorized();
        _approvals[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_owners[tokenId] == address(0)) revert NoSuchToken();
        return _approvals[tokenId];
    }

    function setApprovalForAll(address operator_, bool approved) external {
        if (operator_ == address(0)) revert ZeroAddress();
        _operators[msg.sender][operator_] = approved;
        emit ApprovalForAll(msg.sender, operator_, approved);
    }

    function isApprovedForAll(address holder, address operator_) external view returns (bool) {
        return _operators[holder][operator_];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
        _checkReceiver(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external {
        _transfer(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7    // ERC-165
            || interfaceId == 0x80ac58cd    // ERC-721
            || interfaceId == 0x5b5e139f;   // ERC-721 Metadata
    }

    /// @notice baseURI + decimal token id. Empty while no baseURI is set, which is how ERC-721
    ///         consumers read "no metadata yet" rather than a broken URL.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NoSuchToken();
        string memory b = _baseURI;
        if (bytes(b).length == 0) return "";
        return string.concat(b, _toString(tokenId));
    }

    function _transfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert ZeroAddress();
        address holder = _owners[tokenId];
        if (holder == address(0)) revert NoSuchToken();
        if (holder != from) revert WrongFrom(holder);
        if (msg.sender != holder && msg.sender != _approvals[tokenId] && !_operators[holder][msg.sender]) revert NotAuthorized();

        // A single-token approval is spent by the transfer it authorised.
        if (_approvals[tokenId] != address(0)) _approvals[tokenId] = address(0);
        // Subtract before adding: from == to is a legal no-op transfer and must not underflow.
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    /// @dev Called after the transfer (checks-effects-interactions). Low level rather than try/catch
    ///      so a receiver that returns junk gives UnsafeRecipient instead of an opaque decode panic,
    ///      and a receiver that reverts with a reason keeps that reason.
    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        (bool ok, bytes memory ret) = to.call(
            abi.encodeWithSelector(IERC721Receiver.onERC721Received.selector, msg.sender, from, tokenId, data)
        );
        if (!ok) {
            if (ret.length == 0) revert UnsafeRecipient(to);
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        // >= 32 and compare the leading selector: exactly what abi.decode(ret, (bytes4)) accepts.
        if (ret.length < 32 || bytes4(ret) != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient(to);
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 n = v; n != 0; n /= 10) digits++;
        bytes memory out = new bytes(digits);
        for (uint256 i = digits; v != 0; v /= 10) out[--i] = bytes1(uint8(48 + (v % 10)));
        return string(out);
    }
}
