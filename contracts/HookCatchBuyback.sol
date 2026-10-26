// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minOut, address recipient) external payable;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title Hook Catch buyback & burn
/// @notice Receives the Hook Catch protocol fee in ETH. The ETH can only ever do one thing: buy $HOOKCATCH
///         and send it to the burn address. There is no owner, no withdraw and nothing to configure.
/// @dev Receiving ETH does nothing else, so paying the fee never adds gas or risk to a rule's execution.
///      Anyone (the keeper bot does it) calls buyback() once minBuy has piled up. maxBuy caps each buy so a
///      single buyback is too small to be worth sandwiching. While $HOOKCATCH is on its Pons bonding curve it
///      buys on the curve; after graduation the curve refuses and it buys in the Uniswap v4 pool Pons creates.
contract HookCatchBuyback {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    IUniversalRouter public constant ROUTER = IUniversalRouter(0x8876789976dEcBfCbBbe364623C63652db8C0904);
    address public constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    IERC20 public immutable token;
    IPonsCurve public immutable curve;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    /// @notice smallest buyback worth its gas, and the most spent in one go
    uint256 public immutable minBuy;
    uint256 public immutable maxBuy;

    uint256 public totalEthSpent;
    uint256 public totalBurned;
    uint256 public buybacks;
    bool private locked;

    event Buyback(address indexed caller, uint256 ethSpent, uint256 burned, bool onCurve);

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    constructor(address token_, address curve_, uint24 poolFee_, int24 tickSpacing_, uint256 minBuy_, uint256 maxBuy_) {
        require(token_ != address(0) && curve_ != address(0), "zero address");
        require(minBuy_ > 0 && maxBuy_ >= minBuy_, "bad limits");
        token = IERC20(token_);
        curve = IPonsCurve(curve_);
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        minBuy = minBuy_;
        maxBuy = maxBuy_;
    }

    /// @notice Fees and curve refunds arrive here and wait for the next buyback.
    receive() external payable {}

    /// @notice Anyone can trigger a buyback once at least minBuy ETH is waiting.
    function buyback() external returns (uint256 burned) {
        require(!locked, "busy");
        locked = true;

        uint256 startBalance = address(this).balance;
        uint256 amount = startBalance > maxBuy ? maxBuy : startBalance;
        require(amount >= minBuy, "not enough ETH yet");

        uint256 deadBefore = token.balanceOf(DEAD);
        bool onCurve = true;
        try curve.buy{value: amount}(amount, 0, DEAD) {} catch {
            onCurve = false;
            _buyInPool(amount);
        }
        burned = token.balanceOf(DEAD) - deadBefore;
        require(burned > 0, "nothing bought");

        // the curve refunds what it can't fill at graduation, so count what actually left
        uint256 spent = startBalance - address(this).balance;
        totalEthSpent += spent;
        totalBurned += burned;
        buybacks += 1;
        emit Buyback(msg.sender, spent, burned, onCurve);
        locked = false;
    }

    // V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL (ETH), TAKE_ALL ($HOOKCATCH to this contract), then burn it
    function _buyInPool(uint256 amount) private {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: PoolKey(address(0), address(token), poolFee, tickSpacing, PONS_HOOK),
                zeroForOne: true,
                amountIn: uint128(amount),
                amountOutMinimum: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(address(0), amount);
        params[2] = abi.encode(address(token), uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        ROUTER.execute{value: amount}(hex"10", inputs, block.timestamp);

        uint256 got = token.balanceOf(address(this));
        require(token.transfer(DEAD, got), "burn failed");
    }

    /// @notice ETH waiting for the next buyback.
    function pending() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice True when buyback() would run now.
    function ready() external view returns (bool) {
        return address(this).balance >= minBuy && !locked;
    }
}
