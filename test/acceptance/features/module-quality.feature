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
