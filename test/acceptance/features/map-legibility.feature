@acceptance @legibility
Feature: Map legibility
  As an engineer scanning a large graph
  I want the map to explain its encoding and give me canvas controls
  So that I can read it without guessing

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @legend
  Scenario: The legend explains the encoding
    Then the legend explains size, position, and shape

  @hover
  Scenario: Hovering a node reports its blast radius
    When I hover the "src" node
    Then the blast radius is reported for "src"

  @toolbar
  Scenario: Clearing the selection hides the inspector
    When I select the "src" node
    And I clear the selection
    Then the inspector is hidden

  @boundaries
  Scenario: Boundaries toggles the detail level
    When I toggle boundaries
    Then the detail level is "file"
    When I toggle boundaries
    Then the detail level is "block"

  @prefs
  Scenario: View settings survive a reload
    When I switch to file detail
    And I reload the Strabo UI
    Then the detail level is "file"
    And the detail selector shows "file"

  @renderer
  Scenario: The status bar names the renderer that is actually drawing
    Then the status bar names the renderer the map is drawing with

  @float
  Scenario: A floating panel can be moved and resized, and it survives a reload
    # The legend opens in the right-hand rail, so move it left into open canvas first:
    # dragging it right would push the resize handle past the viewport edge.
    When I drag the "legend" panel by -300, 30
    And I resize the "legend" panel by 60, 40
    And I reload the Strabo UI
    Then the "legend" panel position moved by -300, 30
    And the "legend" panel size grew by 60, 40

  @float
  Scenario: A panel that was never opened still opens at a usable size after another panel moved
    When I drag the "legend" panel by 40, 30
    And I reload the Strabo UI
    And I open the diagnostics panel
    Then the "diagnostics" panel is at least 240 pixels wide

  @strip
  Scenario: The tests strip filters the map
    When I switch to file detail
    And I click the tests strip entry for "tests"
    Then the filter contains "tests"

  @group-select
  Scenario: Selecting a group of nodes offers a group delegate action
    When I switch to file detail
    And I select the "lib/index.ts" and "lib/math.ts" nodes as a group
    Then the group toolbar reports 2 selected
    When I open the group delegate menu
    Then the delegate menu title is "2 file(s)"
    When I clear the selection
    Then the group toolbar reports no selection

  @islands
  Scenario: Directories are drawn as named regions
    Then the map draws no directory islands
    When I switch to file detail
    Then the map draws a directory island for "src/api/v2"
    And the map draws a directory island for "lib"
    And every directory island has a plate on the canvas
    And every island label names a drawn directory
