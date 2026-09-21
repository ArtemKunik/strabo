@acceptance @colors
Feature: Colour budget
  The map reserves hue for status, so two statuses that can appear together are told apart
  by more than their colour.

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @colors
  Scenario: A changed node and an affected node differ by more than hue
    When I open the folder dialog
    And I go up one folder
    And I choose the "timeline-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I review the working tree through the automation hook
    Then a changed node and an affected node differ by more than hue
