@acceptance
Feature: Interoperability: exports, freshness, and headless checks
  As an engineer wiring Strabo into CI, docs, or an agent
  I want the recorded graph available outside the browser
  So that the same facts reach a pipeline without a human opening the map

  Background:
    Given the Strabo server is running against the fixture repository

  @export
  Scenario: Exporting the graph as JSON
    When I request the graph export as "json"
    Then the export envelope names the format "json"
    And the export names the revision it was indexed at

  @export
  Scenario: Exporting the graph as Mermaid and DOT
    When I request the graph export as "mermaid"
    Then the export begins with "graph TD"
    When I request the graph export as "dot"
    Then the export begins with "digraph strabo"

  @status
  Scenario: Freshness is reported
    When I request the freshness status
    Then the status names the indexed revision and whether it is stale

  @check
  Scenario: The headless check flags a recorded cycle
    When I run the check command with "--fail-on-cycles"
    Then the check exits with code 1
    And the check reports a cycle finding

  @check
  Scenario: A baselined finding no longer fails the build
    When I run the check command with "--fail-on-cycles --write-baseline"
    Then the check exits with code 0
    When I run the check command with "--fail-on-cycles"
    Then the check exits with code 0
    And the check reports no new findings
