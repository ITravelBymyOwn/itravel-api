(function () {
  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function plannedActivity(source) {
    return normalize(source?.activity || source?.source_activity);
  }

  function isIndependentWaterfallVisit(source) {
    const activity = plannedActivity(source);
    const place = normalize(source?.commerce_context?.canonical_place ||
      source?.commerce_canonical_place || source?.entity_hint || source?.to);
    const naturalFeature = /\b(?:waterfalls?|cataratas?|cascadas?|[a-z]{3,}foss)\b/;
    if (!naturalFeature.test(place || activity)) return false;

    // A guided excursion, adventure, or designated facility is a different visit.
    return !/\b(?:guided|guiad[oa]s?|tour|canyoning|barranquismo|palace|palacio|museum|museo|visitor center|centro de visitantes)\b/.test(`${place} ${activity}`);
  }

  function hasRequiredSiteAdmission(notes) {
    return normalize(notes).split(/[.!?;\n]/).some(clause =>
      !/\b(?:parking|estacionamiento|aparcamiento|parqueo|shuttle|bus|optional|opcional)\b/.test(clause) &&
      /\b(?:paid admission|entry fee|admission fee|entrada de pago|tarifa de entrada|(?:advance )?(?:admission|entry|entrance) (?:tickets? )?(?:is |are )?(?:required|mandatory)|(?:requires?|must (?:buy|purchase)) (?:an? )?(?:(?:timed |advance )?(?:admission|entry)(?: tickets?)?)|(?:requiere|necesita) (?:una? )?(?:entrada|boleto|billete)|(?:entrada|boleto|billete) (?:es )?(?:necesari[oa]|obligatori[oa])|(?:(?:admission|entry) tickets?|tickets? (?:to enter|for admission)) (?:is |are )?required)\b/.test(clause)
    );
  }

  function hasOnlyOptionalTower(source) {
    const activity = plannedActivity(source);
    const tower = /\b(?:tower|torre|belfry|campanario)\b/;
    if (tower.test(activity)) return false;
    if (!/\b(?:church|cathedral|basilica|iglesia|catedral|basilique|temple|templo)\b/.test(`${activity} ${normalize(source?.notes)}`)) return false;
    const clauses = normalize(source?.notes).split(/[.!?;\n]/);
    const optionalTower = clauses.some(clause => tower.test(clause) && /\b(?:optional|opcional)\b/.test(clause));
    return optionalTower && !hasRequiredSiteAdmission(clauses.filter(clause => !tower.test(clause)).join('. '));
  }

  function blocksSiteAdmission(source) {
    return (isIndependentWaterfallVisit(source) && !hasRequiredSiteAdmission(source?.notes)) ||
      hasOnlyOptionalTower(source);
  }

  function blocksStandaloneTour(source, need, city) {
    if (!blocksSiteAdmission(source)) return false;
    const name = normalize(need?.entity_name).trim();
    const locality = normalize(city).trim();
    // The existing destination-wide overview can use an independent stop as its anchor.
    return name !== `${locality} city tour` && name !== `city tour en ${locality}`;
  }

  const rules = { blocksSiteAdmission, blocksStandaloneTour };
  if (typeof module === 'object' && module.exports) {
    module.exports = rules;
  } else {
    globalThis.itbmoAdmission = rules;
  }
})();
