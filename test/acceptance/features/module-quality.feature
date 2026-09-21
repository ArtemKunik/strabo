@acceptance @quality
Feature: Module quality scorecard
  As an engineer reviewing a repository
  I want every module ranked by repository-percentile quality measures
  So that I can identify the modules that matter most

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @scorecard
  Scenario: The quality endpoint returns a percentile scorecard
    When I request the quality scorecard
    Then the scorecard has a repository name
    And the scorecard lists modules
    And each module has complexity, shape, centrality, evolution, and protection measures
    And each measure group has percentiles for every measure

  @percentiles
  Scenario: Percentiles are computed across the repository
    When I request the quality scorecard
    Then every percentile is between 0 and 100
    And the percentile values match the raw measure values

@change-passport
Scenario: The change passport includes per-function metric and signal deltas
     Given the Strabo server is running against a Kotlin fixture repository
     And I open the Strabo UI
     When I request the change passport for the modified Kotlin file
     Then the change passport includes function changes
     And each function change reports decision points before and after
     And each function change reports signals before and after

@change-passport
Scenario: The change passport includes public-surface diff
     Given the Strabo server is running against a repository with a modified Python file
     And I open the Strabo UI
     When I request the change passport for the modified Python file
     Then the change passport includes public-surface changes
     And each public-surface change reports the extractor language
     And each public-surface change reports added, removed, or changed-signature symbols

@change-passport
Scenario: The change passport includes tiered impact
     Given the Strabo server is running against a repository where a changed file is imported by another module
     When I request the change passport for the modified file
     Then the change passport includes tiered impact
     And the tiered impact reports definite importers whose specifier names a changed symbol
     And the tiered impact reports possible direct importers
     And the tiered impact reports reachable importers transitively
