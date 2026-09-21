@acceptance @workspace
Feature: Multi-repo workspace
  As an engineer working across repositories
  I want the declared workspace and its cross-repo facts in one panel
  So that I can see recorded coupling without leaving the app

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @workspace
  Scenario: The workspace panel reports the configured repository
    When I open the workspace panel
    Then the workspace panel lists the repository "block-repo"
    And the workspace panel reports no cross-repo flows
    And the workspace panel reports no service flows

  @workspace
  Scenario: The workspace panel states unrecorded sections instead of showing them empty
    When I open the workspace panel
    Then the workspace panel reports no contracts recorded
    And the workspace panel reports no service endpoints
