# Bootstrap evaluation for the todo-app spec.
# Per docs/SUCCESS-CRITERIA.md, the eval set is intentionally sparse and grows on
# demand. This single scenario closes the loop: prove that a regenerated
# implementation can be created from durable spec, run through the deletion test,
# and pass an architecture-and-runtime-independent eval expressed in domain terms.

Feature: Tasks

  Scenario: A task can be created and retrieved
    Given no resources of any kind exist
    When a task is created with title "T1" and priority "high"
    Then the request succeeds
    And a task is retrievable with title "T1" and priority "high"
