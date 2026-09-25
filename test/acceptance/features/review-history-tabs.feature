@acceptance @tabs
Feature: Review and History tabs
  As an engineer reviewing recent work
  I want the change set and Git history as full-screen tabs
  So that I can read them at full width instead of in a floating panel

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI
    And I open the folder dialog
    And I go up one folder
    And I choose the "timeline-repo" folder
    And I use the selected folder

  @review
  Scenario: The Review tab shows the pending change set full-screen
    When I open the "review" screen tab
    Then the "review" tab is the active screen
    And the Review screen shows the working-tree change set
    Then the Review screen lists the reviewed file "src/b.ts"

  @history
  Scenario: The History tab lists recorded changes full-screen
    When I open the "history" screen tab
    Then the "history" tab is the active screen
    And the History screen lists recorded changes

  @navigation
  Scenario: Escape returns a tab to the map
    When I open the "history" screen tab
    Then the "history" tab is the active screen
    When I leave the screen tab with Escape
    Then the Graph tab is the active screen

  @scope-fence
  Scenario: The Review screen fences the change set against its declared zone
    When I review the working tree declaring the zone "src/a.ts"
    Then the "review" tab is the active screen
    And the Review screen shows the scope fence section
    And the scope fence lists "src/b.ts" outside the declared zone with importer "src/a.ts"
