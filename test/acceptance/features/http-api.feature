@acceptance @http-api
Feature: HTTP API endpoints
  As an API developer
  I want to see which routes the code registers, which a test reaches, and which have no guard
  So that I can find the endpoints to test or protect before I change them

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @http-endpoints
  Scenario: The HTTP endpoints overlay lists each route with its gaps
    When I open the folder dialog
    And I go up one folder
    And I choose the "api-repo" folder
    And I use the selected folder
    And I select the review overlay "endpoints"
    Then the overlay panel shows "3 endpoint(s) · 1 untested · 2 with no guard recorded"
    And the overlay panel shows "GET /health"
    And the overlay panel shows "DELETE /users/{id}"
    When I select the overlay row for "GET /health"
    Then the inspector is shown for "src/server.ts"
