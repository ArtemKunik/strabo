@acceptance @structure
Feature: Data-flow reading of the Structure view
  As an engineer reading a repository
  I want the recorded reads and writes drawn between role tiers through data hubs
  So that I can see where data enters and leaves each tier, not only where imports run

  # Phase 37: `flow=data` swaps the import reading for the recorded reads and writes routed
  # through data hubs. The fixture records one table written in `domain` and read in `data`.

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @data-flow
  Scenario: The Structure view draws recorded data flows through a hub
    Given I open the structure data-flow fixture repository
    When I switch to structure detail
    And I choose the data-flow reading
    Then the Structure view draws a data hub for "orders"
    And the flow from the "domain" tier into the "orders" hub is drawn as a write
    And the flow from the "orders" hub into the "data" tier is drawn as a read
    And the data-flow legend names read from write
