@acceptance
Feature: Repository dependency map
  As an engineer onboarding to an unfamiliar code
  I want to see how files connect and what a change may reach
  So that I can choose where to investigate and which tests to review

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @overview
  Scenario: Directory overview is the default view
    Then the status line reports nodes and a cache status
    And the graph contains the directory block "src"
    And the breadcrumb shows "repository"

  @drill
  Scenario: Drilling into a directory block
    When I double-click the "src" node
    Then the breadcrumb includes "src"
    And the graph contains the directory block "src/api"

  @evidence
  Scenario: Selecting a file shows its connections
    When I switch to file detail
    And I select the "main.ts" node
    Then the inspector is shown for "main.ts"
    And the inspector lists dependencies and dependents

  @evidence
  Scenario: Tracing a directed path
    When I switch to file detail
    And I select the "main.ts" node
    And I trace to the first listed dependency
    Then the trace reports a step count or an explicit no-path

  @diagnostics
  Scenario: Diagnostics are available
    When I open the diagnostics panel
    Then the diagnostics panel reports counts

  @cache
  Scenario: Refresh requests a new scan
    When I press Refresh
    Then the status line reports cache status "refreshed"

  @optional-integrations
  Scenario: Optional integrations stay explicit
    Then the vulnerabilities endpoint reports available false
    And the graph endpoint still responds

  @browse
  Scenario: Choosing a folder to scan
    When I open the folder dialog
    And I go up one folder
    And I choose the "csharp-repo" folder
    And I use the selected folder
    Then the repository is "csharp-repo"
    And the status line reports nodes and a cache status

  @repository
  Scenario: The repository picker remembers opened repositories
    When I open the folder dialog
    And I go up one folder
    And I choose the "kotlin-repo" folder
    And I use the selected folder
    Then the repository is "kotlin-repo"
    And the repository picker lists "kotlin-repo"
    When I select the remembered "block-repo" repository
    Then the repository is "block-repo"
    And the repository picker marks "block-repo" as active

  @overlay
  Scenario: Test reach overlay marks used-but-untested modules
    When I select the review overlay "test-reach"
    Then the overlay panel reports unreached modules

  @overlay
  Scenario: Cycles overlay marks circular coupling
    When I open the folder dialog
    And I go up one folder
    And I choose the "sample-repo" folder
    And I use the selected folder
    And I select the review overlay "cycles"
    Then the overlay panel reports at least one cycle
