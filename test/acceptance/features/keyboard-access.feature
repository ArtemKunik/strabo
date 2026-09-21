@acceptance @a11y
Feature: Keyboard access
  As an engineer using the app without a pointer
  I want the composite widgets to move with the arrow keys and close on Escape
  So that the chrome is operable from the keyboard

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @a11y
  Scenario: The dock chips move with the arrow keys
    When I close the open panels
    And I focus the first dock chip
    And I press the key "ArrowRight"
    Then the dock chip at index 1 has focus

  @a11y
  Scenario: A floating window closes on Escape and returns focus to its chip
    When I focus the legend window
    And I press the key "Escape"
    Then the legend window is closed
    And the legend dock chip has focus

  @a11y
  Scenario: The canvas overflow menu moves with the arrow keys
    When I close the open panels
    And I open the canvas overflow menu
    And I press the key "ArrowDown"
    Then the menu item at index 1 has focus
    And I press the key "Escape"
    Then the overflow menu is closed and its trigger has focus
