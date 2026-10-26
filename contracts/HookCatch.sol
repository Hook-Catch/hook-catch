// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IPonsCurve {
    function token() external view returns (address);
    function factory() external view returns (address);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function buy(uint256 quoteIn, uint256 minOut, address recipient) external payable;
    function sell(uint256 tokenIn, uint256 minOut, address recipient) external;
}

interface IPoolManager {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title Hook Catch
/// @notice Price rules that trade for you on Robinhood Chain.
///         Sell rules (take profit, stop loss) keep your tokens in your wallet until they fire.
///         Buy rules (buy the dip, DCA) spend ETH you deposit here and can withdraw at any time.
///         Anyone can run a keeper: when a rule's condition is met, a keeper executes it and earns a fee.
/// @dev A rule trades on one venue: a token's Pons bonding curve (and, once it graduates, the Uniswap v4 pool
///      Pons creates: ETH / token, fee 0, tick spacing 200, Pons hook), or any ETH-paired Uniswap v4 pool named
///      by its key. Every trade goes through the official Universal Router or the Pons curve itself.
contract HookCatch {
    // ---------------------------------------------------------------- constants
    address public constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address public constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    uint24 public constant PONS_POOL_FEE = 0;
    int24 public constant PONS_TICK_SPACING = 200;
    IPoolManager public constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IUniversalRouter public constant ROUTER = IUniversalRouter(0x8876789976dEcBfCbBbe364623C63652db8C0904);
    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    bytes32 private constant POOLS_SLOT = bytes32(uint256(6)); // Uniswap v4 PoolManager pools mapping
    bytes4 private constant CURVE_QUOTE = 0x3de35b79; // Pons curve getter for its quote token (zero = ETH)

    uint256 public constant KEEPER_FEE_BPS = 30; // 0.30% of each executed trade, to whoever executes it
    uint256 public constant PROTOCOL_FEE_BPS = 20; // 0.20%, to the fee sink (buyback & burn)
    uint256 public constant DISCOUNT_HOLD = 100_000e18; // holding this much of the Hook Catch token halves the protocol fee
    uint256 public constant FREE_HOLD = 1_000_000e18; // and this much removes it
    uint256 public constant FREE_ACTIVE_RULES = 3; // active rules per wallet without DISCOUNT_HOLD

    enum Kind { SellAbove, SellBelow, BuyBelow, BuyEvery }

    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }

    /// @notice What a user sends to create a rule. For a Pons token pass its curve and leave the pool fields zero;
    ///         for any other token pass curve = 0 and the ETH-paired v4 pool's fee, tick spacing and hooks.
    struct RuleInput {
        address token;
        address curve;
        uint24 poolFee;
        int24 tickSpacing;
        address hooks;
        Kind kind;
        uint128 amount; // per run: tokens to sell, or ETH (wei) to spend
        uint128 trigger; // price in wei of ETH per 1e18 token base units (unused for BuyEvery)
        uint128 limit; // worst acceptable price: sells never fill below it, buys never above it
        uint32 runs;
        uint32 interval; // seconds between runs (BuyEvery)
        uint40 expiry;
    }

    struct Rule {
        address owner;
        address token;
        address curve; // Pons curve, or zero for a plain v4 pool
        address hooks; // v4 pool hooks
        uint24 poolFee;
        int24 tickSpacing;
        Kind kind;
        bool active;
        uint32 runsLeft;
        uint32 interval;
        uint40 nextAt; // earliest time it can fire again
        uint40 expiry; // after this it never fires
        uint128 amount;
        uint128 trigger;
        uint128 limit;
    }

    // ---------------------------------------------------------------- state
    address public owner; // can only set the fee sink and, once, the Hook Catch token
    address public feeSink;
    IERC20 public catchToken; // set once after the token launches
    Rule[] public rules;
    mapping(address => uint256) public deposits; // ETH available for buy rules
    mapping(address => uint256) public activeRules;
    bool private locked;

    // ---------------------------------------------------------------- events
    event RuleCreated(uint256 indexed id, address indexed owner, address indexed token, Kind kind, uint256 amount, uint256 trigger, uint256 limit, uint256 runs, uint256 interval, uint256 expiry);
    event RuleCancelled(uint256 indexed id);
    event RuleExecuted(uint256 indexed id, address indexed keeper, uint256 amountIn, uint256 amountOut, uint256 price, bool onCurve);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event FeeSinkSet(address sink);
    event CatchTokenSet(address token);

    modifier nonReentrant() {
        require(!locked, "busy");
        locked = true;
        _;
        locked = false;
    }

    constructor(address feeSink_) {
        require(feeSink_ != address(0), "no fee sink");
        owner = msg.sender;
        feeSink = feeSink_;
    }

    receive() external payable {} // ETH from curve sells and the router

    // ---------------------------------------------------------------- admin (fees only, never user funds)
    function setFeeSink(address sink) external {
        require(msg.sender == owner, "not owner");
        require(sink != address(0), "no fee sink");
        feeSink = sink;
        emit FeeSinkSet(sink);
    }

    function setCatchToken(address token) external {
        require(msg.sender == owner, "not owner");
        require(address(catchToken) == address(0), "already set");
        catchToken = IERC20(token);
        emit CatchTokenSet(token);
    }

    function renounceOwnership() external {
        require(msg.sender == owner, "not owner");
        owner = address(0);
    }

    // ---------------------------------------------------------------- ETH for buy rules
    function deposit() external payable {
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(deposits[msg.sender] >= amount, "not enough deposited");
        deposits[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- rules
    function createRule(RuleInput calldata i) external returns (uint256 id) {
        require(i.amount > 0 && i.limit > 0 && i.runs > 0, "bad rule");
        require(i.expiry > block.timestamp, "expired");
        require(i.kind == Kind.BuyEvery ? i.interval > 0 : i.trigger > 0, "bad trigger");
        require(i.token != address(0), "bad token");

        Rule memory r;
        r.owner = msg.sender;
        r.token = i.token;
        if (i.curve != address(0)) {
            // a Pons launch: the curve must belong to the token, come from the Pons factory and be paired with ETH
            require(IPonsCurve(i.curve).token() == i.token && IPonsCurve(i.curve).factory() == PONS_FACTORY, "not a Pons curve for this token");
            (bool ok, bytes memory quote) = i.curve.staticcall(abi.encodeWithSelector(CURVE_QUOTE));
            require(ok && quote.length >= 32 && abi.decode(quote, (address)) == address(0), "only ETH-paired launches");
            r.curve = i.curve;
            r.poolFee = PONS_POOL_FEE;
            r.tickSpacing = PONS_TICK_SPACING;
            r.hooks = PONS_HOOK;
        } else {
            // any ETH-paired Uniswap v4 pool, as long as it exists
            require(_sqrtPrice(i.token, i.poolFee, i.tickSpacing, i.hooks) != 0, "pool not found");
            r.poolFee = i.poolFee;
            r.tickSpacing = i.tickSpacing;
            r.hooks = i.hooks;
        }
        if (!_holds(msg.sender, DISCOUNT_HOLD)) require(activeRules[msg.sender] < FREE_ACTIVE_RULES, "rule limit: hold the Hook Catch token for more");

        r.kind = i.kind;
        r.active = true;
        r.runsLeft = i.runs;
        r.interval = i.kind == Kind.BuyEvery ? i.interval : 0;
        r.nextAt = uint40(block.timestamp);
        r.expiry = i.expiry;
        r.amount = i.amount;
        r.trigger = i.trigger;
        r.limit = i.limit;

        id = rules.length;
        rules.push(r);
        activeRules[msg.sender] += 1;
        emit RuleCreated(id, msg.sender, i.token, i.kind, i.amount, i.trigger, i.limit, i.runs, r.interval, i.expiry);
    }

    function cancelRule(uint256 id) external {
        Rule storage r = rules[id];
        require(msg.sender == r.owner, "not your rule");
        require(r.active, "not active");
        _close(r);
        emit RuleCancelled(id);
    }

    /// @notice Executes a rule whose condition is met. Anyone can call it and earns the keeper fee.
    function execute(uint256 id) external nonReentrant returns (uint256 amountOut) {
        Rule storage r = rules[id];
        require(r.active, "not active");
        require(block.timestamp <= r.expiry, "expired");
        require(block.timestamp >= r.nextAt, "too early");

        Rule memory m = r; // working copy; storage is updated before any token or ETH moves
        (uint256 price, bool onCurve) = _price(m);
        if (m.kind == Kind.SellAbove) require(price >= m.trigger, "price below trigger");
        else if (m.kind == Kind.SellBelow) require(price <= m.trigger, "price above trigger");
        else if (m.kind == Kind.BuyBelow) require(price <= m.trigger, "price above trigger");

        r.runsLeft -= 1;
        if (r.runsLeft == 0) _close(r);
        else r.nextAt = uint40(block.timestamp + r.interval);

        uint256 protocolBps = _protocolBps(m.owner);
        uint256 amountIn;
        if (m.kind == Kind.SellAbove || m.kind == Kind.SellBelow) {
            IERC20 t = IERC20(m.token);
            amountIn = _min(m.amount, _min(t.balanceOf(m.owner), t.allowance(m.owner, address(this))));
            require(amountIn > 0, "nothing to sell");
            require(t.transferFrom(m.owner, address(this), amountIn), "pull failed");
            uint256 ethOut = _sellTokens(m, amountIn, (amountIn * m.limit) / 1e18, onCurve);
            uint256 keeperFee = (ethOut * KEEPER_FEE_BPS) / 10_000;
            uint256 protocolFee = (ethOut * protocolBps) / 10_000;
            amountOut = ethOut - keeperFee - protocolFee;
            _send(m.owner, amountOut);
            _send(msg.sender, keeperFee);
            if (protocolFee > 0) _send(feeSink, protocolFee);
        } else {
            amountIn = m.amount;
            require(deposits[m.owner] >= amountIn, "deposit too low");
            deposits[m.owner] -= amountIn;
            uint256 keeperFee = (amountIn * KEEPER_FEE_BPS) / 10_000;
            uint256 protocolFee = (amountIn * protocolBps) / 10_000;
            uint256 spend = amountIn - keeperFee - protocolFee;
            uint256 refund;
            (amountOut, refund) = _buyTokens(m, spend, (spend * 1e18) / m.limit, onCurve);
            if (refund > 0) deposits[m.owner] += refund; // a curve that fills only part at graduation sends the rest back
            _send(msg.sender, keeperFee);
            if (protocolFee > 0) _send(feeSink, protocolFee);
        }
        emit RuleExecuted(id, msg.sender, amountIn, amountOut, price, onCurve);
    }

    // ---------------------------------------------------------------- views
    /// @notice Spot price of a Pons token in wei of ETH per 1e18 token units: its v4 pool once it graduated, else the curve.
    function priceOf(address token, address curve) public view returns (uint256 price, bool onCurve) {
        Rule memory m;
        m.token = token;
        m.curve = curve;
        m.poolFee = PONS_POOL_FEE;
        m.tickSpacing = PONS_TICK_SPACING;
        m.hooks = PONS_HOOK;
        return _price(m);
    }

    /// @notice Spot price in an ETH-paired v4 pool, in wei of ETH per 1e18 token base units.
    function poolPrice(address token, uint24 fee, int24 tickSpacing, address hooks) external view returns (uint256) {
        uint160 sqrtP = _sqrtPrice(token, fee, tickSpacing, hooks);
        require(sqrtP != 0, "pool not found");
        return _fromSqrt(sqrtP);
    }

    function ruleKey(uint256 id) external view returns (PoolKey memory) {
        Rule storage r = rules[id];
        return PoolKey(address(0), r.token, r.poolFee, r.tickSpacing, r.hooks);
    }

    /// @notice Whether a rule can be executed right now (for keepers).
    function canExecute(uint256 id) external view returns (bool ok, string memory why) {
        Rule memory r = rules[id];
        if (!r.active) return (false, "not active");
        if (block.timestamp > r.expiry) return (false, "expired");
        if (block.timestamp < r.nextAt) return (false, "too early");
        (uint256 price,) = _price(r);
        if (r.kind == Kind.SellAbove && price < r.trigger) return (false, "price below trigger");
        if ((r.kind == Kind.SellBelow || r.kind == Kind.BuyBelow) && price > r.trigger) return (false, "price above trigger");
        if (r.kind == Kind.SellAbove || r.kind == Kind.SellBelow) {
            IERC20 t = IERC20(r.token);
            if (t.balanceOf(r.owner) == 0 || t.allowance(r.owner, address(this)) == 0) return (false, "nothing to sell");
        } else if (deposits[r.owner] < r.amount) {
            return (false, "deposit too low");
        }
        return (true, "");
    }

    function rulesCount() external view returns (uint256) {
        return rules.length;
    }

    function getRules(uint256 from, uint256 to) external view returns (Rule[] memory out) {
        if (to > rules.length) to = rules.length;
        if (from >= to) return out;
        out = new Rule[](to - from);
        for (uint256 i = from; i < to; i++) out[i - from] = rules[i];
    }

    function protocolFeeBps(address user) external view returns (uint256) {
        return _protocolBps(user);
    }

    // ---------------------------------------------------------------- internals
    function _close(Rule storage r) private {
        r.active = false;
        activeRules[r.owner] -= 1;
    }

    function _holds(address user, uint256 amount) private view returns (bool) {
        return address(catchToken) != address(0) && catchToken.balanceOf(user) >= amount;
    }

    function _protocolBps(address user) private view returns (uint256) {
        if (_holds(user, FREE_HOLD)) return 0;
        if (_holds(user, DISCOUNT_HOLD)) return PROTOCOL_FEE_BPS / 2;
        return PROTOCOL_FEE_BPS;
    }

    function _price(Rule memory m) private view returns (uint256 price, bool onCurve) {
        uint160 sqrtP = _sqrtPrice(m.token, m.poolFee, m.tickSpacing, m.hooks);
        if (sqrtP != 0) return (_fromSqrt(sqrtP), false);
        require(m.curve != address(0), "pool not found");
        (uint256 q, uint256 t) = IPonsCurve(m.curve).getReserves();
        return ((q * 1e18) / t, true);
    }

    // currency0 is ETH, so sqrtP^2 / 2^192 is token units per wei; invert it and scale to 1e18 token units
    function _fromSqrt(uint160 sqrtP) private pure returns (uint256) {
        uint256 a = (uint256(1) << 192) / sqrtP;
        return (a * 1e18) / sqrtP;
    }

    function _sqrtPrice(address token, uint24 fee, int24 tickSpacing, address hooks) private view returns (uint160) {
        bytes32 poolId = keccak256(abi.encode(address(0), token, fee, tickSpacing, hooks));
        bytes32 slot0 = POOL_MANAGER.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)));
        return uint160(uint256(slot0));
    }

    function _key(Rule memory m) private pure returns (PoolKey memory) {
        return PoolKey(address(0), m.token, m.poolFee, m.tickSpacing, m.hooks);
    }

    function _sellTokens(Rule memory m, uint256 amountIn, uint256 minOut, bool onCurve) private returns (uint256 ethOut) {
        uint256 before = address(this).balance;
        if (onCurve) {
            IERC20(m.token).approve(m.curve, amountIn);
            IPonsCurve(m.curve).sell(amountIn, minOut, address(this));
        } else {
            IERC20(m.token).approve(address(PERMIT2), type(uint256).max);
            PERMIT2.approve(m.token, address(ROUTER), uint160(amountIn), uint48(block.timestamp));
            bytes[] memory params = new bytes[](3);
            params[0] = abi.encode(ExactInputSingleParams(_key(m), false, uint128(amountIn), uint128(minOut), ""));
            params[1] = abi.encode(m.token, amountIn); // SETTLE_ALL token
            params[2] = abi.encode(address(0), minOut); // TAKE_ALL ETH to this contract
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = abi.encode(hex"060c0f", params);
            ROUTER.execute(hex"10", inputs, block.timestamp);
        }
        ethOut = address(this).balance - before;
        require(ethOut >= minOut, "below limit");
    }

    function _buyTokens(Rule memory m, uint256 spend, uint256 minOut, bool onCurve) private returns (uint256 got, uint256 refund) {
        uint256 before = IERC20(m.token).balanceOf(m.owner);
        uint256 ethBefore = address(this).balance;
        if (onCurve) {
            IPonsCurve(m.curve).buy{value: spend}(spend, minOut, m.owner);
        } else {
            bytes[] memory params = new bytes[](3);
            params[0] = abi.encode(ExactInputSingleParams(_key(m), true, uint128(spend), uint128(minOut), ""));
            params[1] = abi.encode(address(0), spend); // SETTLE_ALL ETH
            params[2] = abi.encode(m.token, m.owner, uint256(0)); // TAKE the whole output straight to the rule owner
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = abi.encode(hex"060c0e", params);
            ROUTER.execute{value: spend}(hex"10", inputs, block.timestamp);
        }
        got = IERC20(m.token).balanceOf(m.owner) - before;
        uint256 spent = ethBefore - address(this).balance;
        refund = spend > spent ? spend - spent : 0;
        require(got >= minOut, "above limit");
    }

    struct ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData; }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
