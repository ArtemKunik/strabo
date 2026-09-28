@acceptance @structure
Feature: Application logical structure from the tier lens
  As an engineer reading a repository
  I want the role tiers drawn as a structure joined by recorded imports
  So that I can see how the application is layered, not just where files sit on disk

# Y3 draws the bands, the wrong-way edges, and the shelf; Y4 draws the unit × tier grid.
# The end-to-end spine (Y6) is not built yet, so that scenario stays @wip to keep the run green.

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @bands
  Scenario: The Structure lens draws tier bands joined by recorded imports
    Given I open the structure fixture repository
    When I switch to structure detail
    Then the Structure view draws a band for "frontend"
    And the Structure view draws a band for "api"
    And the Structure view draws a band for "domain"
    And the Structure view draws a band for "data"
    And the Structure legend names role tiers, not layers

  @wrong-way
  Scenario: A wrong-way dependency rides on the band drawing
    Given I open the structure fixture repository
    When I switch to structure detail
    Then the flow from "api" to "data" is drawn as a skip-layer edge
    And the flow from "data" to "domain" is drawn as an upward edge

  @shelf
  Scenario: Support tiers sit on a shelf, not in the stack
    Given I open the structure fixture repository
    When I switch to structure detail
    Then the Structure view draws a support shelf
    And the "tests" tier is on the support shelf, not a band

  @grid
  Scenario: The unit by tier grid draws two build units
    Given I open the structure fixture repository
    When I switch to structure detail
    And I turn on the structure grid
    Then the Structure view draws a column for "orders-api"
    And the Structure view draws a column for "web"
    And the Structure grid draws a cell for "web" in "frontend"
    And the cross-unit flow from "web" in "frontend" to "orders-api" in "api" is drawn

  @drilldown
  Scenario: Drilling into a cell opens its files with breadcrumb navigation
    Given I open the structure fixture repository
    When I switch to structure detail
    And I turn on the structure grid
    And I drill into the cell for "orders-api" in "data"
    Then the view shows the files of "orders-api" in "data"
    And the breadcrumb reads "Structure › orders-api › Data"
    When I exit the cell with Escape
    Then the Structure view returns to the grid

  @spine
  Scenario: Opening a recorded call follows the end-to-end spine
    Given I open the structure fixture repository
    When I switch to structure detail
    And I open the recorded call from the "frontend" band
    Then the spine follows the call to its declared endpoint
    And the spine reaches the table "orders"
