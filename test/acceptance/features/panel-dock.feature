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
  Scenario: Dock, strip, and zoom controls do not overlap
    Then the dock does not overlap the tests strip
    And the zoom controls sit above the dock
