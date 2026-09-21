@acceptance @islands
Feature: Directory islands can be moved
  As an engineer re-arranging the map around how I understand the code
  I want to move a directory island as one group
  So that a layout I chose survives a reload and can be reset

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @drag
  Scenario: A moved island survives a reload and resets to the computed layout
    When I switch to file detail
    And I note the position of the "lib/index.ts" node
    When I drag the island "lib" right by 140 pixels
    Then the island layout records a move for "lib"
    And the "lib/index.ts" node has moved from the noted position
    When I reload the Strabo UI
    Then the island layout records a move for "lib"
    And the "lib/index.ts" node has moved from the noted position
    When I reset the map layout
    Then the island layout is empty
    And the "lib/index.ts" node is back at the noted position
