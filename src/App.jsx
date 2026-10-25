import { useCallback, useEffect, useMemo, useState } from 'react'
import City from './City.jsx'
import { BAND_M, MAX_START_M, MINUTES, SHOP_MAX_MIN, WALK_M_PER_MIN, computeReach, prepare } from './reach.js'
import { REACH_COLORS, SHOP_COLOR, USE_COLORS, USE_LABELS } from './palette.js'

const FILES = {
  kit: 'kit.json',
  buildings: 'buildings.geojson',
  graph: 'streets.graph.json',
  zensus: 'zensus.geojson',
  shops: 'shops.geojson',
}

// Worded as in public/data/SOURCES.md.
const ATTRIBUTION =
  'Buildings: 3D building models LoD2 © GDI-Th (dl-de/by-2-0). Land use and pedestrian network: Egor Gaydukov, InfAU, Bauhaus-Universität Weimar. Census grid: Zensus 2022, © Statistische Ämter des Bundes und der Länder (dl-de/by-2-0). Shops: © OpenStreetMap contributors (ODbL).'

export default function App() {
  const [city, setCity] = useState(null)
  const [error, setError] = useState(null)
  const [reach, setReach] = useState(null)
  const [busy, setBusy] = useState(false)
  const [shopMinutes, setShopMinutes] = useState(10)
  const [shopType, setShopType] = useState('all')
  const [hoveredShop, setHoveredShop] = useState(null)

  useEffect(() => {
    const load = ([key, file]) =>
      fetch(`${import.meta.env.BASE_URL}data/${file}`).then((r) => {
        if (!r.ok) throw new Error(`data/${file}: ${r.status}`)
        return r.json().then((json) => [key, json])
      })
    Promise.all(Object.entries(FILES).map(load))
      .then((entries) => setCity(prepare(Object.fromEntries(entries))))
      .catch((e) => setError(e.message))
  }, [])

  // Let the panel say "Walking…" before the calculation takes the main thread.
  const onPick = useCallback(
    (point) => {
      setBusy(true)
      setTimeout(() => {
        setReach(computeReach(city, point))
        setBusy(false)
      }, 0)
    },
    [city],
  )

  const uses = useMemo(() => {
    if (!city) return []
    const counts = {}
    for (const h of city.houses) counts[h.use] = (counts[h.use] ?? 0) + 1
    return Object.keys(USE_COLORS).filter((u) => counts[u])
  }, [city])

  // The shops within the chosen time, and of the chosen type.
  const reachedShops = useMemo(() => {
    if (!reach?.shops) return []
    return reach.shops.filter((t) => t.minutes <= shopMinutes)
  }, [reach, shopMinutes])
  const shopTypes = useMemo(() => {
    const counts = {}
    for (const t of reachedShops) {
      const type = city.shops[t.index].shop
      counts[type] = (counts[type] ?? 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [reachedShops, city])
  const shownShops = useMemo(
    () => (shopType === 'all' ? reachedShops : reachedShops.filter((t) => city.shops[t.index].shop === shopType)),
    [reachedShops, shopType, city],
  )

  if (error) return <p className="message">The city kit didn't load ({error}).</p>
  if (!city) return <p className="message">Loading the city…</p>

  return (
    <div className="app">
      <City city={city} reach={reach} onPick={onPick} shownShops={shownShops} hoveredShop={hoveredShop} />

      <aside className="panel">
        <h1>How far can you walk?</h1>
        <Status reach={reach} busy={busy} />
        <table>
          <thead>
            <tr>
              <th />
              <th>Buildings</th>
              <th>Residents</th>
            </tr>
          </thead>
          <tbody>
            {MINUTES.map((m, i) => {
              const area = reach?.areas?.[i]
              return (
                <tr key={m}>
                  <th>
                    <span className="swatch" style={{ background: REACH_COLORS[m] }} />
                    {m} min
                  </th>
                  <td>{area ? area.buildings.size.toLocaleString('en') : '–'}</td>
                  <td>
                    {area ? `about ${area.residents.toLocaleString('en')}` : '–'}
                    {area?.unknownCells > 0 && (
                      <span className="note">
                        {' '}
                        + {area.unknownCells} {area.unknownCells === 1 ? 'cell' : 'cells'} without a figure
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <h2>Shops you can reach</h2>
        <label className="slider">
          <span>
            Within <strong>{shopMinutes} min</strong> ({(shopMinutes * WALK_M_PER_MIN).toLocaleString('en')} m)
          </span>
          <input
            type="range"
            min={1}
            max={SHOP_MAX_MIN}
            value={shopMinutes}
            onChange={(e) => setShopMinutes(Number(e.target.value))}
          />
        </label>
        {reach?.shops ? (
          <>
            <select value={shopType} onChange={(e) => setShopType(e.target.value)}>
              <option value="all">All types ({reachedShops.length})</option>
              {shopTypes.map(([type, n]) => (
                <option key={type} value={type}>
                  {shopTypeLabel(type)} ({n})
                </option>
              ))}
              {shopType !== 'all' && !shopTypes.some(([type]) => type === shopType) && (
                <option value={shopType}>{shopTypeLabel(shopType)} (0)</option>
              )}
            </select>
            {shownShops.length === 0 ? (
              <p className="status">No shops of this type within {shopMinutes} min.</p>
            ) : (
              <ol className="shops">
                {shownShops.map((t) => {
                  const s = city.shops[t.index]
                  return (
                    <li
                      key={t.index}
                      onMouseEnter={() => setHoveredShop(t.index)}
                      onMouseLeave={() => setHoveredShop(null)}
                    >
                      <span className="swatch" style={{ background: SHOP_COLOR }} />
                      <span className="shop-name">{s.name ?? <em>No name in OpenStreetMap</em>}</span>
                      <span className="shop-time">{Math.max(1, Math.ceil(t.minutes))} min</span>
                      <span className="note">
                        {[shopTypeLabel(s.shop), s.address, s.opening_hours].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          </>
        ) : (
          <p className="status">Click on the ground to list the shops in walking distance.</p>
        )}

        <div className="method">
          <p>
            The walk starts at the street node nearest to your click, if one is within {MAX_START_M} m. It follows the
            pedestrian network at 4.8 km/h, which is {WALK_M_PER_MIN} m per minute, so {MINUTES.map((m) => `${m * WALK_M_PER_MIN} m`).join(', ')}{' '}
            in {MINUTES.join(', ')} minutes.
          </p>
          <p>
            Each area is the stretch of street you reach in that time, including part of the last street, with a band of{' '}
            {BAND_M} m on each side. A building counts when it touches the area.
          </p>
          <p>
            Residents come from the Zensus 2022 100 m grid. Each cell that overlaps the area adds its population times
            the share of the cell inside the area; the sum is rounded to the nearest 10. Some cells have no published
            figure: they are left out of the sum, not counted as zero, and the panel says how many.
          </p>
          <p>
            Shops come from OpenStreetMap, which volunteers map: a few may be missing, closed or out of date. The time to
            a shop is the walk along the network to the point of street nearest the shop, plus the straight line from
            there to the shop, at the same {WALK_M_PER_MIN} m per minute. Hover over a shop in the list to find it on
            the map.
          </p>
        </div>
      </aside>

      <aside className="legend">
        {uses.map((u) => (
          <div key={u}>
            <span className="swatch" style={{ background: USE_COLORS[u] }} />
            {USE_LABELS[u]}
          </div>
        ))}
      </aside>

      <footer className="attribution">{ATTRIBUTION}</footer>
    </div>
  )
}

// OpenStreetMap types such as "second_hand" read as "Second hand".
function shopTypeLabel(type) {
  const words = (type ?? 'shop').replaceAll('_', ' ').replaceAll(';', ', ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function Status({ reach, busy }) {
  if (busy) return <p className="status">Walking…</p>
  if (!reach) return <p className="status">Click on the ground to start a walk. Drag to orbit, right-drag to pan, scroll to zoom.</p>
  if (reach.tooFar) return <p className="status warn">No walkable street within {MAX_START_M} m of this point. Click closer to a street.</p>
  return (
    <p className="status">
      Start: street node {Math.round(reach.startDistance)} m from your click.
    </p>
  )
}
