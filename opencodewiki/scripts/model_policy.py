"""Which model each agent in a generated workflow runs on.

The policy exists because quota is the binding constraint, not capability. Running thirty fan-out
agents on the strongest model exhausts a day's budget on work that is mostly recognition and
extraction — reading a bounded set of files and reporting what is there. The judgment-heavy stages
are few, and they are the ones where being wrong poisons everything downstream.

So the rule has two regimes:

  small run  (<= SMALL_RUN_AGENTS total)  ->  everything on the strong model
  large run  (anything more)              ->  fan-out on the fast model, consolidation on the strong

A small run is cheap enough that there is no reason to economise; a large one is where the
difference between thirty strong-model agents and thirty fast ones is the difference between
finishing the week and not.
"""

STRONG = "opus"
FAST = "sonnet"

# A run of roughly this size or smaller is affordable entirely on the strong model. Sized from a
# realistic small repo: around eight parallel units plus two consolidation stages.
SMALL_RUN_AGENTS = 10


def plan_models(fanout_count, consolidation_count):
    """Return (fanout_model, consolidation_model, all_strong, total).

    `consolidation_count` should be the worst case, not the expected case — a run that stays small
    only because the critic happened to pass on the first round is not actually a small run, and
    deciding the policy from a lucky outcome would make cost unpredictable.
    """
    total = fanout_count + consolidation_count
    all_strong = total <= SMALL_RUN_AGENTS
    if all_strong:
        return STRONG, STRONG, True, total
    return FAST, STRONG, False, total


def describe(fanout_count, consolidation_count):
    """One line explaining the choice, for the generated script's log and the command's report."""
    fanout, consolidation, all_strong, total = plan_models(fanout_count, consolidation_count)
    if all_strong:
        return (
            f"{total} agents (<= {SMALL_RUN_AGENTS}): running everything on {STRONG}"
        )
    return (
        f"{total} agents (> {SMALL_RUN_AGENTS}): {fanout_count} fan-out on {fanout}, "
        f"{consolidation_count} consolidation on {consolidation}"
    )
