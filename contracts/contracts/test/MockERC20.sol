// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only ERC-20, shaped like $FLYBRAIN (18 decimals). Never deployed off a local chain.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        return true;
    }

    function _spendAllowance(address from, uint256 amount) internal {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Fee-on-transfer variant: 5% of every transfer is skimmed, so 0x...dEaD receives less
///         than the canvas asked for. The burn helper must catch that and revert.
contract MockERC20Tax is MockERC20 {
    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = (amount * 5) / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        emit Transfer(from, address(0), fee);
    }
}

/// @notice transferFrom moves the tokens but returns `false`. A burn that trusted the balance delta
///         alone would accept it.
contract MockERC20FalseReturn is MockERC20 {
    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_) {}

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        return false;
    }
}

/// @notice transferFrom returns nothing at all (the pre-EIP-20 style some tokens still ship). The
///         burn helper accepts empty return data, so this one must work.
contract MockERC20NoReturn is MockERC20 {
    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_) {}

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        assembly {
            return(0, 0)
        }
    }
}

interface IClaim {
    function claim(uint64 canvasId, uint256 maxBurn) external;
}

interface IPaint {
    function commit(uint64 canvasId, bytes32 strokeRoot, bytes32 inputHash, uint32 strokes) external;
    function currentCanvas() external view returns (uint64);
}

/// @notice The nastiest adversary the design has to survive: a token that is ALSO the operator and
///         repaints the canvas from inside the burn, after the claimer was shown a picture. The
///         claim must freeze what was committed before it, never what this sneaks in.
contract MockERC20Painter is MockERC20 {
    address public canvas;
    bytes32 public sneakRoot;
    bool public sneak;
    bool public sneakOk;

    constructor() MockERC20("Painter", "PNT") {}

    function setCanvas(address canvas_) external {
        canvas = canvas_;
    }

    function paint(uint64 id, bytes32 root, bytes32 input, uint32 strokes) external {
        IPaint(canvas).commit(id, root, input, strokes);
    }

    function setSneak(bytes32 root, bool on) external {
        sneakRoot = root;
        sneak = on;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        if (sneak) {
            uint64 id = IPaint(canvas).currentCanvas();
            (bool ok, ) = canvas.call(
                abi.encodeWithSelector(IPaint.commit.selector, id, sneakRoot, sneakRoot, uint32(999999))
            );
            sneakOk = ok;
        }
        return true;
    }
}

/// @notice Calls claim() again from inside transferFrom, i.e. while the canvas is mid-freeze. The
///         reentrancy lock has to stop it. The canvas address is set after deployment because the
///         canvas takes its burn token in its own constructor - one of the two has to come second.
///         `swallow` keeps the inner revert data instead of bubbling it, so a test can prove the
///         lock (and not something else) is what refused the second claim.
contract MockERC20Reenter is MockERC20 {
    address public canvas;
    uint64 public reenterCanvasId;
    bool public swallow;
    bytes public lastRevert;
    uint256 public reenterCalls;

    constructor() MockERC20("Reenter", "RE") {}

    function setCanvas(address canvas_, uint64 id, bool swallow_) external {
        canvas = canvas_;
        reenterCanvasId = id;
        swallow = swallow_;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        reenterCalls += 1;
        (bool ok, bytes memory ret) = canvas.call(
            abi.encodeWithSelector(IClaim.claim.selector, reenterCanvasId, type(uint256).max)
        );
        require(!ok, "reentrant claim went through");
        lastRevert = ret;
        if (!swallow) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return true;
    }
}
