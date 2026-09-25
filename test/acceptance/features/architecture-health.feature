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

  @declared-rules
  Scenario: The Declared rules overlay lists the rules and their violations
    When I open the folder dialog
    And I go up one folder
    And I choose the "declared-repo" folder
    And I use the selected folder
    And I select the review overlay "declared-rules"
    Then the overlay panel reports the declared rule "domain-no-infra"
    And the overlay panel reports the violating edge from "domain/service.ts" to "infra/config.properties"
    And the overlay panel reports the violating edge from "domain/service.ts" to "infra/server.ts"
    When I select the overlay row for "domain/service.ts"
    Then the inspector is shown for "domain/service.ts"
