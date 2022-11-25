pragma solidity 0.8.16;

import "../dvm/MockDvmFixture.sol";

import "../../../../contracts/optimistic-assertor/implementation/test/OptimisticAssertorTest.sol";
import "../../../../contracts/common/implementation/TestnetERC20.sol";

// Fixture to deploy a configured OptimisticAssertorTest with reasonable default values.
contract OptimisticAssertorFixture is Test {
    struct OptimisticAssertorContracts {
        Timer timer;
        Finder finder;
        Store store;
        AddressWhitelist addressWhitelist;
        IdentifierWhitelist identifierWhitelist;
        MockOracleAncillary mockOracle;
        TestnetERC20 defaultCurrency;
        OptimisticAssertorTest optimisticAssertor;
    }

    function setUp() public returns (OptimisticAssertorContracts memory) {
        MockDvmFixture.BaseMockDvmContracts memory baseMockDvmContracts = new MockDvmFixture().setUp();

        TestnetERC20 defaultCurrency = new TestnetERC20("Default Bond Token", "DBT", 18);

        vm.startPrank(TestAddress.owner);

        baseMockDvmContracts.addressWhitelist.addToWhitelist(address(defaultCurrency));
        baseMockDvmContracts.identifierWhitelist.addSupportedIdentifier("ASSERT_TRUTH");
        uint256 defaultBond = 100e18;
        uint256 defaultLiveness = 7200; // 2 hours
        OptimisticAssertorTest optimisticAssertor =
            new OptimisticAssertorTest(
                baseMockDvmContracts.finder,
                defaultCurrency,
                defaultBond,
                defaultLiveness,
                address(baseMockDvmContracts.timer)
            );
        baseMockDvmContracts.store.setFinalFee(address(defaultCurrency), FixedPoint.Unsigned(50e18)); // Half of the default bond.

        vm.stopPrank();

        return
            OptimisticAssertorContracts(
                baseMockDvmContracts.timer,
                baseMockDvmContracts.finder,
                baseMockDvmContracts.store,
                baseMockDvmContracts.addressWhitelist,
                baseMockDvmContracts.identifierWhitelist,
                baseMockDvmContracts.mockOracle,
                defaultCurrency,
                optimisticAssertor
            );
    }
}

contract OptimisticAssertorFixtureTest is Test {
    function testDefaultConfiguration() public {
        OptimisticAssertorFixture.OptimisticAssertorContracts memory oaContracts =
            new OptimisticAssertorFixture().setUp();

        oaContracts.addressWhitelist.isOnWhitelist(address(oaContracts.defaultCurrency));
        oaContracts.identifierWhitelist.isIdentifierSupported("ASSERT_TRUTH");
        assertEq(address(oaContracts.optimisticAssertor.defaultCurrency()), address(oaContracts.defaultCurrency));
        assertEq(oaContracts.optimisticAssertor.defaultBond(), 100e18);
        assertEq(oaContracts.optimisticAssertor.defaultLiveness(), 7200);
    }
}