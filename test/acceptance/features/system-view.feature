@acceptance @system
Feature: System view
  As an engineer reading a repository
  I want the map to group files by build unit
  So that I can see what is deployed rather than where files sit on disk

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @units
  Scenario: The System view draws units and a support shelf
    When I switch to system detail
    Then the System view draws the unit "block-repo"
    And the System view draws a support shelf for "block-repo"
    And the System legend names build units

  @caption
  Scenario: A unit says why it is grouped
    When I switch to system detail
    And I select the root unit node
    Then the inspector reports why the unit is grouped
