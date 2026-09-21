/**
 * "What should this look like?", asked mid-turn.
 *
 * The model has stopped before writing anything — a document, a deck, a page —
 * to ask which standard to hold it to. Like `SkillApproval`, the turn is
 * genuinely blocked on the server while this is on screen, so it is drawn at
 * the point in the transcript where the waiting is rather than as a toast.
 *
 * Unlike an approval, every answer here is a real answer. There is no refusal:
 * "No standard" is a choice the model is told about and carries on from. So
 * nothing is styled as the dangerous button, and the card is a list of
 * standards rather than a pair of verbs.
 *
 * Presets and the reader's own are offered in one list, tagged by where they
 * came from. A standard someone wrote themselves is the more specific answer,
 * so theirs sort to the top; the presets are the fallback everyone has.
 */
export function DesignChoice({ skill, onChoose }) {
  const { id, options, answered, expired, askedFor } = skill.design;
  const listed = options || [];
  // Custom first: someone who has saved their own house style is almost never
  // reaching past it for "Swiss grid".
  const ordered = [
    ...listed.filter((o) => o.source === "custom"),
    ...listed.filter((o) => o.source !== "custom"),
  ];
  const picked = answered ? listed.find((o) => o.id === answered) : null;

  return (
    <div className="design-ask" data-answered={answered ? "" : undefined}>
      <div className="design-ask-head">
        <span className="design-ask-label mi">Design standard</span>
        <span className="design-ask-name">What should this look like?</span>
      </div>

      {/* The list can appear for two different reasons, and they are not the
          same question. Unprompted, it means "you have not said". After a
          standard was asked for by name and matched nothing, it means "not
          that one, but here is what there is" -- and saying so is what stops
          someone concluding their own standard has gone missing. */}
      {askedFor && !answered && !expired ? (
        <p className="design-ask-note">
          Nothing here is called “{askedFor}”. These are the standards you have:
        </p>
      ) : null}

      {expired ? (
        <p className="design-ask-note">
          That question is no longer waiting — the turn was stopped, or it stood
          long enough that the answer was made without you.
        </p>
      ) : answered ? (
        <p className="design-ask-note">
          {answered === "none"
            ? "No standard — its own judgement."
            : `${picked?.name || "Chosen"} — handing it over…`}
        </p>
      ) : (
        <>
          <ul className="design-ask-list">
            {ordered.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="design-opt"
                  onClick={() => onChoose(id, option.id)}
                >
                  <span className="design-opt-top">
                    <span className="design-opt-name">{option.name}</span>
                    {option.source === "custom" ? (
                      <span className="design-opt-source mi">Yours</span>
                    ) : null}
                  </span>
                  {option.summary ? (
                    <span className="design-opt-summary">{option.summary}</span>
                  ) : null}
                  {option.tags?.length ? (
                    <span className="design-opt-tags">
                      {option.tags.map((tag) => (
                        <span className="design-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {/* Declining is a row like the others, at the foot where it does not
              compete with the standards. It is not a cancel: the model is told
              to use its own judgement and gets on with the work either way. */}
          <button
            type="button"
            className="design-opt"
            data-none=""
            onClick={() => onChoose(id, "none")}
          >
            <span className="design-opt-top">
              <span className="design-opt-name">No standard</span>
            </span>
            <span className="design-opt-summary">
              Let it use its own judgement.
            </span>
          </button>
        </>
      )}
    </div>
  );
}
