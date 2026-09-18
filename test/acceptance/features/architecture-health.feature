@acceptance @health
Feature: Architecture health
  As an engineer judging a repository
  I want heuristic health signals with their underlying values
  So that the score is explainable rather than a verdict

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @axes
  Scenario: Health axes are reported as signals
    When I select the review overlay "architecture"
    Then the overlay panel reports a health score
    And the overlay panel lists health axes
