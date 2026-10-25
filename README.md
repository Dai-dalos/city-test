# How far can you walk? Central Weimar

A 3D map of central Weimar that shows how far you can walk in 5, 10 and 15 minutes from any point, and about how many people live in that area.

Buildings stand at their measured height and are coloured by their main use, with a legend. Click on the ground and the app walks the pedestrian network from the nearest street node. Three nested areas appear in three shades of orange, and the buildings that touch each area take the matching shade. A panel lists, for each time, the number of buildings reached and about how many residents live there. Below it, a slider from 1 to 20 minutes lists the shops you can reach by name, nearest first, with type, address and opening hours; you can narrow the list to one type, such as bakeries, and hover over a shop to find its pin on the map.

## Run it

```
npm install     install the packages
npm run dev     start the app at http://localhost:5173
```

Drag to orbit, right-drag to pan, scroll to zoom, click on the ground to start a walk.

`npm run build` makes the site in `dist/`. GitHub Pages builds and publishes it on every push to `main`, at `https://<user>.github.io/<repo>/`.

## Method and its limits

- **Start.** The walk starts at the walkable street node nearest to the click. If no node is within 100 m, the app says so and doesn't walk. The few metres from the click to that node are not counted.
- **Walking.** The walk follows the walkable edges of the pedestrian network, using their length in metres, at 4.8 km/h, which is 80 m per minute: 400 m in 5 minutes, 800 m in 10, 1200 m in 15. It ignores slopes, steps, crossings and waiting at traffic lights.
- **Areas.** Each area is the street segments reached in that time, including the reachable part of the last segment, with a band of 25 m on each side, joined into one shape. It is not a circle and not a convex hull. The band stands for the buildings along a street, not for the actual entrances.
- **Buildings.** A building counts as reached when its footprint touches the area, that is, comes within 25 m of a reached stretch of street. Counts are cumulative: the 10-minute count includes the 5-minute buildings.
- **Residents.** Residents come from the Zensus 2022 100 m grid. For every cell that overlaps the area, the app takes its population times the share of the cell's area that lies inside the area, adds these up and rounds to the nearest 10. This assumes people are spread evenly over each cell. The census changes small counts slightly at random to protect privacy, so the figure is approximate.
- **Cells without a figure.** Some cells have no published population (`null`). They are not zero: they are left out of the sum, and the panel says how many such cells overlap the area.
- **Shops.** Shops come from OpenStreetMap (see `public/data/SOURCES.md`). Each shop is tied to the nearest point on a walkable street. Its time is the walk along the network to that point, from whichever end of the street is quicker, plus the straight line from the street to the shop, at 80 m per minute. Times are rounded up to the next minute, so a shop shown as 5 min is in the list at 5 minutes. Volunteers map OpenStreetMap: a few shops may be missing, closed or out of date.
- **Map.** Distances are measured on a flat local grid around the kit centre; across 2 km the error is well under 0.1 %. The kit covers only central Weimar, so walks near its edge stop at the edge of the data.

## Code

| Path | What it is |
| --- | --- |
| `src/App.jsx` | the start page: loads the data, the panel, the legend and the attribution |
| `src/City.jsx` | the 3D view with React Three Fiber: ground, streets, areas, buildings merged into one mesh |
| `src/reach.js` | the walk, the 25 m bands, buildings reached, residents counted and walking time to every shop |
| `src/palette.js` | the colours for uses and for the three areas |
| `public/data/` | the city kit; `SOURCES.md` there lists every file, its source, licence and fields |

## Data sources

| Data | Source | Licence |
| --- | --- | --- |
| Building footprints and heights | 3D building models LoD2 of Thuringia, © GDI-Th, surveyed 14 October 2024 | dl-de/by-2-0 |
| Building uses | Egor Gaydukov, InfAU, Bauhaus-Universität Weimar | |
| Pedestrian network | Egor Gaydukov, InfAU, Bauhaus-Universität Weimar | |
| Shops | OpenStreetMap, © OpenStreetMap contributors, data as of 15 July 2026 | ODbL |
| Residents, 100 m grid | Zensus 2022, © Statistische Ämter des Bundes und der Länder, reference date 15 May 2022 | dl-de/by-2-0 |

Buildings: 3D building models LoD2 © GDI-Th (dl-de/by-2-0). Land use and pedestrian network: Egor Gaydukov, InfAU, Bauhaus-Universität Weimar. Census grid: Zensus 2022, © Statistische Ämter des Bundes und der Länder (dl-de/by-2-0). Shops: © OpenStreetMap contributors (ODbL).

## How this was made

1. Tools: Claude Code, with Claude Opus 5.5 (claude-opus-5-5).
2. I decided:
3. The agent did: read the city kit, wrote the walking, band and resident calculations and the 3D view, tested them on sample clicks, and wrote this README.
4. I checked:
