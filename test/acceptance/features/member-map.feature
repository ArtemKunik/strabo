@acceptance @member-map
Feature: Member map
  As an engineer inspecting a class
  I want its members and the field wiring the scan recorded
  So that I can see which behaviour touches which state

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @recorded
  Scenario: Member map reports fields, methods, and data flow
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    Then the member map lists fields with declared types
    And the member map lists methods as behaviour
    And the data flow panels report sources, resources, transforms, and sinks

  @unrecorded
  Scenario: Unrecorded wiring is reported as unavailable
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Plain.kt" node
    Then the data flow reports wiring is not recorded

  @member-view @back
  Scenario: The member map steps back to the Module Passport
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    When I step the member map back
    Then the member map is closed and the module passport is shown for "Counter.kt"

  @member-view
  Scenario: Member map view with a flow walkthrough
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    Then the member map view shows fields, clusters, and the data flow
    And the member map view draws the recorded wiring as a diagram
    And the member map view shows architecture health and the dependency constellation
    When I step through the flow walkthrough
    Then the flow walkthrough reports the wiring step
    When I step to the data flow step
    Then playing the walkthrough animates the data flow panels

  @member-view
  Scenario: Hovering a member traces the wiring the scan recorded
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    When I hover the "value" field card
    Then the methods wired to "value" are traced
    When I hover the "fail" method card
    Then the field wired to "fail" is traced

  @member-view
  Scenario: Playing the members step reveals cards in cluster order
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    When I step to the members step
    And I play the walkthrough
    Then the member cards reveal in cluster order

  @member-view @deep-link
  Scenario: A deep link reopens the member map
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    When I reload the page
    Then the member map is open for "src/main/kotlin/com/acme/app/Counter.kt"

  @member-view @no-rebuild
  Scenario: A walkthrough step does not rebuild the member cards
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    Then stepping the walkthrough keeps the member card nodes

  @member-view @narrator
  Scenario: The member map offers the narrator and stays inert without configuration
    When I open the folder dialog
    And I go up one folder
    And I choose the "member-repo" folder
    And I use the selected folder
    And I switch to file detail
    And I select the "src/main/kotlin/com/acme/app/Counter.kt" node
    And I open the member map
    Then the member map offers the narrator and reports it is off
