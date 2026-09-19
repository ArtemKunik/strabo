@acceptance @risk
Feature: Dependency risk
  As an engineer reviewing a repository
  I want to see its dependencies, vulnerabilities, and licenses
  So that I can judge supply-chain risk before I change anything

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @inventory
  Scenario: The offline risk report lists dependencies and their importers
    When I request the risk report for the "risk-repo" fixture
    Then the risk report lists the lodash dependency
    And the risk report maps lodash to the file that imports it
    And the risk report reports undeclared imports

  @online
  Scenario: Online advisory and license lookup stays opt-in
    When I request the risk report for the "risk-repo" fixture
    Then the risk report reports that online lookup is disabled
