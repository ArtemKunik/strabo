@acceptance @dock
Feature: Panel dock
  As an engineer using floating panels
  I want gated panels to show when they can open
  So that a click never silently does nothing

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @gating
  Scenario: Gated dock chips disable until their context exists
    Then the "Edge" dock chip is disabled
    And the "Passport" dock chip is disabled
    And the "Member map" dock chip is disabled
    When I switch to file detail
    And I select the "main.ts" node
    Then the "Passport" dock chip is enabled
    When I clear the selection
    Then the "Passport" dock chip is disabled

  @test-reach
  Scenario: Test reach overlay reports counts
    When I select the review overlay "test-reach"
    Then the overlay panel reports test reach counts
    And the overlay panel reports unreached modules

  @layout
  Scenario: The panel rail runs down the graph's right edge, clear of the zoom controls
    Then the panel rail sits on the right edge of the graph
    And the zoom controls do not overlap the panel rail
