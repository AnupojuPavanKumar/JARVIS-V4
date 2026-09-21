// Pure local unit conversion — no external API required.
// Categories: temperature, length, weight/mass, volume, speed

// ── Normalise unit aliases ──────────────────────────────────────
const ALIASES = {
    // temperature
    c: 'celsius', celsius: 'celsius', '°c': 'celsius',
    f: 'fahrenheit', fahrenheit: 'fahrenheit', '°f': 'fahrenheit',
    k: 'kelvin', kelvin: 'kelvin',
    // length
    mm: 'millimeter', millimeter: 'millimeter', millimeters: 'millimeter',
    cm: 'centimeter', centimeter: 'centimeter', centimeters: 'centimeter',
    m: 'meter', meter: 'meter', meters: 'meter',
    km: 'kilometer', kilometer: 'kilometer', kilometers: 'kilometer',
    in: 'inch', inch: 'inch', inches: 'inch', '"': 'inch',
    ft: 'foot', foot: 'foot', feet: 'foot', "'": 'foot',
    yd: 'yard', yard: 'yard', yards: 'yard',
    mi: 'mile', mile: 'mile', miles: 'mile',
    // weight / mass
    mg: 'milligram', milligram: 'milligram', milligrams: 'milligram',
    g: 'gram', gram: 'gram', grams: 'gram',
    kg: 'kilogram', kilogram: 'kilogram', kilograms: 'kilogram',
    lb: 'pound', pound: 'pound', pounds: 'pound', lbs: 'pound',
    oz: 'ounce', ounce: 'ounce', ounces: 'ounce',
    t: 'metric_ton', tonne: 'metric_ton', 'metric ton': 'metric_ton', 'metric_ton': 'metric_ton',
    // volume
    ml: 'milliliter', milliliter: 'milliliter', milliliters: 'milliliter',
    l: 'liter', liter: 'liter', liters: 'liter', litre: 'liter', litres: 'liter',
    gal: 'gallon', gallon: 'gallon', gallons: 'gallon',
    pt: 'pint', pint: 'pint', pints: 'pint',
    qt: 'quart', quart: 'quart', quarts: 'quart',
    cup: 'cup', cups: 'cup',
    tbsp: 'tablespoon', tablespoon: 'tablespoon', tablespoons: 'tablespoon',
    tsp: 'teaspoon', teaspoon: 'teaspoon', teaspoons: 'teaspoon',
    floz: 'fluid_ounce', 'fl oz': 'fluid_ounce', 'fluid ounce': 'fluid_ounce', fluid_ounce: 'fluid_ounce',
    // speed
    'km/h': 'km_h', kmh: 'km_h', kph: 'km_h', 'kilometer per hour': 'km_h',
    'mi/h': 'mph', mph: 'mph', 'mile per hour': 'mph',
    'm/s': 'm_s', 'meter per second': 'm_s', mps: 'm_s',
    knot: 'knot', knots: 'knot', kt: 'knot',
};

// ── Base-unit conversion tables (convert TO base, convert FROM base) ──
// Temperature is handled specially (non-linear).
const CONVERSIONS = {
    // LENGTH — base: meter
    length: {
        millimeter: { to: v => v / 1000, from: v => v * 1000 },
        centimeter: { to: v => v / 100, from: v => v * 100 },
        meter:      { to: v => v, from: v => v },
        kilometer:  { to: v => v * 1000, from: v => v / 1000 },
        inch:       { to: v => v * 0.0254, from: v => v / 0.0254 },
        foot:       { to: v => v * 0.3048, from: v => v / 0.3048 },
        yard:       { to: v => v * 0.9144, from: v => v / 0.9144 },
        mile:       { to: v => v * 1609.344, from: v => v / 1609.344 },
    },
    // WEIGHT — base: kilogram
    weight: {
        milligram:   { to: v => v / 1e6, from: v => v * 1e6 },
        gram:        { to: v => v / 1000, from: v => v * 1000 },
        kilogram:    { to: v => v, from: v => v },
        pound:       { to: v => v * 0.45359237, from: v => v / 0.45359237 },
        ounce:       { to: v => v * 0.02834952, from: v => v / 0.02834952 },
        metric_ton:  { to: v => v * 1000, from: v => v / 1000 },
    },
    // VOLUME — base: liter
    volume: {
        milliliter:   { to: v => v / 1000, from: v => v * 1000 },
        liter:        { to: v => v, from: v => v },
        gallon:       { to: v => v * 3.785411784, from: v => v / 3.785411784 },
        pint:         { to: v => v * 0.473176473, from: v => v / 0.473176473 },
        quart:        { to: v => v * 0.946352946, from: v => v / 0.946352946 },
        cup:          { to: v => v * 0.2365882365, from: v => v / 0.2365882365 },
        tablespoon:   { to: v => v * 0.01478676478, from: v => v / 0.01478676478 },
        teaspoon:     { to: v => v * 0.00492892159, from: v => v / 0.00492892159 },
        fluid_ounce:  { to: v => v * 0.02957352956, from: v => v / 0.02957352956 },
    },
    // SPEED — base: meter per second
    speed: {
        m_s:  { to: v => v, from: v => v },
        km_h: { to: v => v / 3.6, from: v => v * 3.6 },
        mph:  { to: v => v * 0.44704, from: v => v / 0.44704 },
        knot: { to: v => v * 0.51444, from: v => v / 0.51444 },
    },
};

function normalise(u) {
    return ALIASES[(u || '').toLowerCase().trim()] || u.toLowerCase().trim();
}

function detectCategory(unit) {
    if (['celsius','fahrenheit','kelvin'].includes(unit)) return 'temperature';
    for (const [cat, map] of Object.entries(CONVERSIONS)) {
        if (unit in map) return cat;
    }
    return null;
}

function convertTemperature(value, from, to) {
    let celsius;
    if (from === 'celsius')    celsius = value;
    else if (from === 'fahrenheit') celsius = (value - 32) * 5 / 9;
    else if (from === 'kelvin')     celsius = value - 273.15;

    if (to === 'celsius')    return celsius;
    if (to === 'fahrenheit') return celsius * 9 / 5 + 32;
    if (to === 'kelvin')     return celsius + 273.15;
}

function runConvert() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const value = parseFloat(args.value);
    const from  = normalise(args.from || '');
    const to    = normalise(args.to   || '');

    if (isNaN(value) || !from || !to) {
        return console.log(JSON.stringify({
            ok: false,
            skill: 'unit_convert',
            error: 'Params required: value (number), from (unit), to (unit).'
        }));
    }

    const catFrom = detectCategory(from);
    const catTo   = detectCategory(to);

    if (!catFrom || !catTo) {
        return console.log(JSON.stringify({
            ok: false,
            skill: 'unit_convert',
            error: `Unrecognised unit: "${!catFrom ? from : to}". Supported: temperature (C/F/K), length, weight, volume, speed.`
        }));
    }

    if (catFrom !== catTo) {
        return console.log(JSON.stringify({
            ok: false,
            skill: 'unit_convert',
            error: `Cannot convert ${catFrom} to ${catTo}.`
        }));
    }

    let result;
    if (catFrom === 'temperature') {
        result = convertTemperature(value, from, to);
    } else {
        const base = CONVERSIONS[catFrom][from].to(value);
        result = CONVERSIONS[catFrom][to].from(base);
    }

    // Round to 6 significant figures
    const rounded = parseFloat(result.toPrecision(6));

    console.log(JSON.stringify({
        ok: true,
        skill: 'unit_convert',
        data: {
            original_value: value,
            from_unit: from,
            to_unit: to,
            result: rounded,
            category: catFrom
        }
    }));
}

runConvert();
