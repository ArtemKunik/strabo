@sandbox
Feature: Refactor sandbox
  An operator tries an architecture change on a copy of the recorded graph before writing it,
  and prices an extraction before starting it. Every answer is labelled hypothetical and is
  read from recorded facts only.

  Background:
    Given the Strabo server is running against the fixture repository
    And I open the Strabo UI
    And I switch to file detail

  Scenario: An import that closes a loop is reported as a hypothetical cycle
    When I right-click the "src/util.ts" node
    And I choose the menu entry "Start an import from here"
    And I right-click the "src/index.ts" node
    And I choose the menu entry "Add import util.ts → here"
    Then the sandbox labels its answer hypothetical
    And the sandbox reports a cycle introduced through "src/index.ts" and "src/util.ts"
    And the "src/util.ts" node is ringed as a cycle

  Scenario: Planning an extraction names what it imports and who imports it
    When I plan extracting "src" in the sandbox
    Then the sandbox lists "lib/index.ts" as an outside import
    And the sandbox lists "src/index.ts" as imported from outside
