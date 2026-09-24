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

  @composites
  Scenario: The scorecard carries composite hotspot and risk scores
    When I request the quality scorecard
    Then each module reports composite scores in 0-100
    And each module reports a hotspot and a risk

  @smells
  Scenario: The smells endpoint reports rules with their inputs
    When I request the repository smells
    Then the smells report lists files with a rule summary
    And each smell names a rule and its inputs

# These three change-passport scenarios describe an endpoint and fixture the runner cannot
# drive yet: there is no step for "the change passport for the modified <language> file", and
# no fixture that pairs a language-specific edit with its importers. They are captured as
# @wip so the run stays green until the steps and fixtures are built. The implemented change
# passport is exercised by the cohesion scenario in timeline.feature.
@wip @change-passport
Scenario: The change passport includes per-function metric and signal deltas
     Given the Strabo server is running against a Kotlin fixture repository
     And I open the Strabo UI
     When I request the change passport for the modified Kotlin file
     Then the change passport includes function changes
     And each function change reports decision points before and after
     And each function change reports signals before and after

@wip @change-passport
Scenario: The change passport includes public-surface diff
     Given the Strabo server is running against a repository with a modified Python file
     And I open the Strabo UI
     When I request the change passport for the modified Python file
     Then the change passport includes public-surface changes
     And each public-surface change reports the extractor language
     And each public-surface change reports added, removed, or changed-signature symbols

@wip @change-passport
Scenario: The change passport includes tiered impact
     Given the Strabo server is running against a repository where a changed file is imported by another module
     When I request the change passport for the modified file
     Then the change passport includes tiered impact
     And the tiered impact reports definite importers whose specifier names a changed symbol
     And the tiered impact reports possible direct importers
     And the tiered impact reports reachable importers transitively
