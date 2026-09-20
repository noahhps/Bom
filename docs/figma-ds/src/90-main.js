/* Entry point. Run in a new, empty Figma design file:
 *   Plugins > Development > Import plugin from manifest > docs/figma-ds/manifest.json
 * It refuses to touch a file that already has content. */

function newPage(name, fallback) {
  try {
    const p = figma.createPage();
    p.name = name;
    return p;
  } catch (e) {
    NOTES.push(`This plan caps pages, so "${name}" was placed on "${fallback.name}".`);
    return fallback;
  }
}

async function main() {
  const existing = await figma.variables.getLocalVariableCollectionsAsync();
  if (existing.length || figma.root.children.length > 1 || figma.currentPage.children.length) {
    return "Courier Design System: run this in a new, empty design file. Nothing was changed.";
  }

  await Promise.all(["Regular", "Medium", "Italic"].map((style) => figma.loadFontAsync({ family: "DM Mono", style })));
  try {
    MARK = figma.createImage(figma.base64Decode(MARK_B64)).hash;
  } catch (e) {
    NOTES.push("The mark image could not be embedded; a flat placeholder stands in.");
  }

  await buildTokens();
  await buildStyles();

  const cover = figma.currentPage;
  cover.name = "Cover";
  const foundations = newPage("Foundations", cover);
  const components = newPage("Components", foundations);
  const patterns = newPage("Patterns", components);

  await figma.setCurrentPageAsync(components);
  await buildComponents(components);

  await figma.setCurrentPageAsync(foundations);
  await buildFoundations(foundations);

  await figma.setCurrentPageAsync(patterns);
  await buildPatterns(patterns);

  await figma.setCurrentPageAsync(cover);
  await buildCover(cover, NOTES);

  const sets = Object.values(REG).filter((r) => r.node.type === "COMPONENT_SET");
  const variants = sets.reduce((n, r) => n + r.node.children.length, 0);
  const singles = Object.values(REG).filter((r) => r.node.type === "COMPONENT").length;
  const vars = Object.keys(V).filter((k) => typeof V[k] === "object").length;
  return (
    `Courier Design System built: ${vars} variables in 4 collections (${MODES.length} accent modes), ` +
    `${Object.keys(TS).length} text styles, ${Object.keys(ES).length} effect styles, ` +
    `${sets.length} component sets (${variants} variants) + ${singles} components.` +
    (NOTES.length ? ` ${NOTES.length} note(s) on the Cover.` : "")
  );
}

main()
  .then((message) => figma.closePlugin(message))
  .catch((error) => {
    console.error(error);
    figma.closePlugin("Courier Design System failed: " + (error && error.message ? error.message : error));
  });
