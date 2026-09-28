@acceptance @structure
Feature: Application logical structure from the tier lens
  As an engineer reading a repository
  I want the role tiers drawn as a structure joined by recorded imports
  So that I can see how the application is layered, not just where files sit on disk

# These scenarios describe the Structure lens (roadmap Phase 35, slices Y3-Y6). The tier
# classification (Phase 16) exists and the fixture below is recorded, but the aggregate
# (Y1), the bands (Y3), and the grid (Y4) are not built yet. They are captured as @wip so the
# run stays green until those slices land; the aggregate itself is asserted headlessly in
# test/unit/tiers.test.ts once Y1 ships.

  @wip @bands
  Scenario: The Structure lens draws tier bands joined by recorded imports
    Given the Strabo server is running against the structure fixture repository
    And I open the Strabo UI
    When I switch to structure detail
    Then the Structure view draws a band for "frontend"
    And the Structure view draws a band for "api"
    And the Structure view draws a band for "domain"
    And the Structure view draws a band for "data"
    And the Structure legend names role tiers, not layers

  @wip @wrong-way
  Scenario: A wrong-way dependency rides on the band drawing
    Given the Strabo server is running against the structure fixture repository
    And I open the Strabo UI
    When I switch to structure detail
    Then the flow from "api" to "data" is drawn as a skip-layer edge
    And the flow from "data" to "domain" is drawn as an upward edge

  @wip @shelf
  Scenario: Support tiers sit on a shelf, not in the stack
    Given the Strabo server is running against the structure fixture repository
    And I open the Strabo UI
    When I switch to structure detail
    Then the Structure view draws a support shelf
    And the "tests" tier is on the support shelf, not a band

  @wip @grid
  Scenario: The unit by tier grid draws two build units
    Given the Strabo server is running against the structure fixture repository
    And I open the Strabo UI
    When I switch to structure detail
    Then the Structure view draws a column for "orders-api"
    And the Structure view draws a column for "web"

  @wip @spine
  Scenario: Opening a recorded call follows the end-to-end spine
    Given the Strabo server is running against the structure fixture repository
    And I open the Strabo UI
    When I switch to structure detail
    And I open the recorded call from the "frontend" band
    Then the spine follows the call to its declared endpoint
    And the spine reaches the table "orders"
