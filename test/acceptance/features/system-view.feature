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

  @units-only
  Scenario: L0 draws units, never files
    When I switch to system detail
    Then the System view draws units only

  @caption
  Scenario: A unit says why it is grouped
    When I switch to system detail
    And I select the root unit node
    Then the inspector reports why the unit is grouped

  @polyglot
  Scenario: A polyglot repository groups into its build units
    Given I open the polyglot fixture repository
    When I switch to system detail
    Then the System view draws the unit "mobile-app"
    And the System view draws the unit "alpha"
    And the System view draws the unit "beta"
    And the System view draws a support shelf for "mobile-app"

  @open-unit
  Scenario: Opening a unit shows its files inside the frame
    Given I open the polyglot fixture repository
    When I switch to system detail
    And I open the unit "beta"
    Then the breadcrumb reads "System › beta"
    And the map draws the file "crates/beta/src/lib.rs"
    And no import edge crosses the unit frame
    When I press Escape
    Then the System view draws units only

  @unit-edges
  Scenario: Selecting a file draws only its in-unit edges
    Given I open the polyglot fixture repository
    When I switch to system detail
    And I open the unit "crates/alpha"
    And I select the file "crates/alpha/src/main.rs"
    Then only the selected file's in-unit edges are drawn

  @outside
  Scenario: Outside links appear only after the action
    Given I open the polyglot fixture repository
    When I switch to system detail
    And I open the unit "web"
    And I select the file "web/src/app.ts"
    Then no import edge crosses the unit frame
    When I show outside links
    Then an outside link badge reads "1 file in @acme/lib"

