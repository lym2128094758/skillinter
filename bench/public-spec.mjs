// Source-variable descriptions and published CSV headers were checked before running either arm.
export const publicSpec = [
  ['iris', 53, 'iris', 'Align the sepal length and petal width measurements.', [['sepal_length','sepal length'],['flower_petal_width','petal width']]],
  ['wine-chemistry', 109, 'wine', 'Align total phenols and colour intensity.', [['total_phenols','Total_phenols'],['colour_strength','Color_intensity']]],
  ['abalone', 1, 'abalone', 'Align shell diameter and mass of the dried shell.', [['shell_diameter','Diameter'],['dry_shell_mass','Shell_weight']]],
  ['glass', 42, 'glass+identification', 'Align optical refractive index and sodium measurement.', [['refractive_index','RI'],['sodium','Na']]],
  ['airfoil', 291, 'airfoil+self-noise', 'Align acoustic frequency and free stream air speed.', [['frequency','frequency'],['air_speed','free-stream-velocity']]],
  ['concrete', 165, 'concrete+compressive+strength', 'Align the curing age and measured compressive strength.', [['age','Age'],['compression_strength','Concrete compressive strength']]],
  ['wine-red', 186, 'wine+quality', 'Align residual sugar and alcohol content.', [['residual_sugar','residual_sugar'],['ethanol_content','alcohol']], 'red'],
  ['wine-white', 186, 'wine+quality', 'Align density and free sulfur dioxide.', [['density','density'],['free_so2','free_sulfur_dioxide']], 'white'],
  ['rice', 545, 'rice+cammeo+and+osmancik', 'Align outline perimeter and length of the major axis.', [['perimeter','Perimeter'],['major_axis_length','Major_Axis_Length']]],
  ['raisin', 850, 'raisin', 'Align area and outline perimeter.', [['area','Area'],['outline_length','Perimeter']]],
].map(([id, sourceId, slug, goal, gold, color]) => ({
  id, sourceId, source: 'https://archive.ics.uci.edu/dataset/' + sourceId + '/' + slug,
  download: 'https://archive.ics.uci.edu/static/public/' + sourceId + '/data.csv',
  goal, color: color ?? null, gold: Object.fromEntries(gold),
  request: {fields: gold.map(([name]) => ({name, type: 'number', required: true, minimum: 0}))},
}));
