'use strict';
/**
 * Build new worldRounds entries from real Mapillary panoramas.
 *
 * Usage (Node 18+, needs internet):
 *   MAPILLARY_TOKEN="MLY|xxxx|yyyy" node fetchPanos.js
 *
 * For each target it searches for 360° images (is_pano=true) captured since
 * MIN_YEAR, picks the one closest to the target, and uses THAT image's own
 * coordinates as the answer (so the answer always matches what players see).
 * Output: worldRounds.new.json  (ids start at w23; paste into worldRounds.json)
 */
const fs = require('fs');

const TOKEN ='MLY|28241307835482284|40a9903301c40dd2362c530bd97e51ee'
if (!TOKEN) { console.error('Set MAPILLARY_TOKEN'); process.exit(1); }

const MIN_YEAR     = 2018;            // skip old/low-quality captures
const RADII_M      = [150, 400, 1000]; // widen the search if nothing is found
const START_ID     = 23;

// name, hint (shown after the round), approx. lat/lng (the script snaps to a real pano)
const TARGETS = [
  // Asia
  { hint: 'Tokyo, Japan',              lat: 35.6595,  lng: 139.7005 },
  { hint: 'Seoul, South Korea',        lat: 37.5759,  lng: 126.9769 },
  { hint: 'Bangkok, Thailand',         lat: 13.7567,  lng: 100.5018 },
  { hint: 'Singapore',                 lat: 1.2834,   lng: 103.8607 },
  { hint: 'Mumbai, India',             lat: 18.9220,  lng: 72.8347  },
  { hint: 'Chennai, India',            lat: 13.0500,  lng: 80.2824  },
  { hint: 'Hanoi, Vietnam',            lat: 21.0285,  lng: 105.8522 },
  // Middle East
  { hint: 'Istanbul, Turkey',          lat: 41.0054,  lng: 28.9768  },
  { hint: 'Dubai, UAE',                lat: 25.1972,  lng: 55.2744  },
  // Africa
  { hint: 'Cape Town, South Africa',   lat: -33.9025, lng: 18.4195  },
  { hint: 'Nairobi, Kenya',            lat: -1.2864,  lng: 36.8172  },
  { hint: 'Marrakech, Morocco',        lat: 31.6258,  lng: -7.9891  },
  { hint: 'Accra, Ghana',              lat: 5.5486,   lng: -0.1978  },
  // South America
  { hint: 'Rio de Janeiro, Brazil',    lat: -22.9711, lng: -43.1822 },
  { hint: 'Buenos Aires, Argentina',   lat: -34.6037, lng: -58.3816 },
  { hint: 'Santiago, Chile',           lat: -33.4378, lng: -70.6505 },
  { hint: 'Bogotá, Colombia',          lat: 4.5981,   lng: -74.0760 },
  { hint: 'Lima, Peru',                lat: -12.0464, lng: -77.0300 },
  // North / Central America
  { hint: 'Mexico City, Mexico',       lat: 19.4326,  lng: -99.1332 },
];

function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bbox({ lat, lng }, radiusM) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((n) => n.toFixed(6)).join(',');
}

async function findPano(target) {
  for (const r of RADII_M) {
    const url =
      'https://graph.mapillary.com/images' +
      `?access_token=${encodeURIComponent(TOKEN)}` +
      '&fields=id,computed_geometry,geometry,is_pano,captured_at' +
      `&bbox=${bbox(target, r)}&is_pano=true&limit=200`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const { data = [] } = await res.json();

    const candidates = data
      .filter((img) => img.is_pano && new Date(img.captured_at).getUTCFullYear() >= MIN_YEAR)
      .map((img) => {
        const [lng, lat] = (img.computed_geometry ?? img.geometry).coordinates;
        return { id: img.id, lat, lng, d: haversineKm(target, { lat, lng }) };
      })
      .sort((a, b) => a.d - b.d);

    if (candidates.length) return { ...candidates[0], radiusM: r };
  }
  return null;
}

(async () => {
  const out = [];
  let n = START_ID;

  for (const t of TARGETS) {
    try {
      const pano = await findPano(t);
      if (!pano) { console.warn(`✗ ${t.hint}: no recent 360° image found — pick another spot`); continue; }
      out.push({
        id: `w${String(n).padStart(2, '0')}`,
        type: 'world',
        label: `Round ${n} — World`,
        panoId: String(pano.id),
        previewUrl: '',
        lat: pano.lat,
        lng: pano.lng,
        locationHint: t.hint,
      });
      console.log(`✓ ${t.hint}: ${pano.id} (${Math.round(pano.d * 1000)} m from target)`);
      n += 1;
    } catch (err) {
      console.warn(`✗ ${t.hint}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to the API
  }

  fs.writeFileSync('worldRounds.new.json', JSON.stringify(out, null, 2));
  console.log(`\nWrote ${out.length} rounds to worldRounds.new.json`);
  console.log('Open each in your host page once to confirm the viewer loads before the event.');
})();