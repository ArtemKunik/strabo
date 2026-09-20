@acceptance @timeline
Feature: Timeline and compare versions
  As an engineer reviewing recent work
  I want to compare a recorded revision with the working tree
  So that I can see what a change may reach

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI

  @compare
  Scenario: Impact between a revision and the working tree
    When I open the folder dialog
    And I go up one folder
    And I choose the "timeline-repo" folder
    And I use the selected folder
    And I open the timeline
    Then the timeline lists recorded changes
    When I select the most recent change
    Then the overlay panel reports changed files

  @review
  Scenario: Reviewing a commit's own changes
    When I open the folder dialog
    And I go up one folder
    And I choose the "timeline-repo" folder
    And I use the selected folder
    And I open the timeline
    When I select the most recent change
    Then the review panel reports the commit and its changed files

  @review
  Scenario: Reviewing pending working-tree changes
    When I open the folder dialog
    And I go up one folder
    And I choose the "timeline-repo" folder
    And I use the selected folder
    When I open the working-tree review
    Then the review panel reports a working-tree review

  @review @change-passport
  Scenario: The Change passport reports the cohesion a change made
    When I open the folder dialog
    And I go up one folder
    And I choose the "change-repo" folder
    And I use the selected folder
    When I open the working-tree review
    Then the change passport reports a cohesion delta

  @review @delegate
  Scenario: Delegating the pending change set hands over the review evidence
    When I open the folder dialog
    And I go up one folder
    And I choose the "timeline-repo" folder
    And I use the selected folder
    When I open the working-tree review
    And I right-click the review panel
    Then the delegate menu title is "pending working tree"
