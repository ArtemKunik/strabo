@acceptance @passport
Feature: Module Passport
  As an engineer reviewing a file
  I want its dependency metrics and evidence in one place
  So that I can judge the blast radius of a change

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @metrics
  Scenario: The passport reports metrics for a selected file
    When I switch to file detail
    And I select the "main.ts" node
    Then the inspector shows the passport metrics for "main.ts"
    And the inspector lists dependencies and dependents

  @unavailable
  Scenario: Unrecorded detail is reported as unavailable
    When I switch to file detail
    And I select the "main.ts" node
    Then the inspector reports members as not recorded

  @back
  Scenario: The passport steps back to the module it was opened from, then to the map
    When I switch to file detail
    And I select the "main.ts" node
    Then the inspector shows the passport metrics for "main.ts"
    When I open the first inspector dependency
    When I step the module passport back
    Then the inspector shows the passport metrics for "main.ts"
    When I step the module passport back
    Then the module passport is closed

  @members
  Scenario: Members are listed for a supported language
    When I open the folder dialog
    And I go up one folder
    And I choose the "kotlin-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Main.kt" node
    Then the inspector lists members including "helper"

  @functions
  Scenario: Functions are listed with body metrics for a supported language
    When I switch to file detail
    And I select the "main.ts" node
    Then the inspector lists functions including "main"
    And the inspector reports body metrics for a listed function
    And the inspector shows a functions summary with a sortable table

  @narrator
  Scenario: The narrator is offered but stays inert without configuration
    When I switch to file detail
    And I select the "main.ts" node
    Then the inspector offers the narrator and reports it is off

  @narrator
  Scenario: The narrator is set up from Settings against a loopback stub
    Given a loopback narrator stub is running
    When I open the Settings window
    And I set the narrator endpoint to the stub and model "stub-model"
    And I save the narrator settings
    And I switch to file detail
    And I select the "main.ts" node
    And I narrate the "main.ts" file
    Then the narrative reports the stub reply

  @narrator
  Scenario: Changing the endpoint host clears the stored key
    Given a loopback narrator stub is running
    When I open the Settings window
    And I set the narrator endpoint to the stub and model "stub-model"
    And I save the narrator settings
    And I store a narrator key
    Then the narrator panel reports the key is stored
    When I change the narrator endpoint host
    Then the narrator panel reports the key is missing
