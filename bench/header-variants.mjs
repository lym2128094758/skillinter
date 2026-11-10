// Frozen developer-authored translations. These perturb known public tables,
// and are not independent laboratory data or a test of pretraining exclusion.
export const headerVariants = {
  'sepal length': '萼片长度', 'sepal width': '萼片宽度', 'petal length': '花瓣长度', 'petal width': '花瓣宽度', class: '类别',
  Alcohol: '酒精度', Malicacid: '苹果酸含量', Ash: '灰分', Alcalinity_of_ash: '灰分碱度', Magnesium: '镁含量',
  Total_phenols: '总酚含量', Flavanoids: '黄酮含量', Nonflavanoid_phenols: '非黄酮酚含量', Proanthocyanins: '原花青素',
  Color_intensity: '色泽强度', Hue: '色调', '0D280_0D315_of_diluted_wines': '稀释酒液吸光度比', Proline: '脯氨酸',
  Sex: '性别', Length: '长度', Diameter: '直径', Height: '高度', Whole_weight: '整体重量', Shucked_weight: '去壳肉重',
  Viscera_weight: '内脏重量', Shell_weight: '壳重', Rings: '环数',
  Id_number: '记录编号', RI: '折射率', Na: '钠含量', Mg: '镁含量', Al: '铝含量', Si: '硅含量',
  K: '钾含量', Ca: '钙含量', Ba: '钡含量', Fe: '铁含量', Type_of_glass: '玻璃类别',
  frequency: '声学频率', 'attack-angle': '攻角', 'chord-length': '弦长', 'free-stream-velocity': '来流速度',
  'suction-side-displacement-thickness': '吸力面位移厚度', 'scaled-sound-pressure': '标度声压',
  Cement: '水泥用量', 'Blast Furnace Slag': '高炉矿渣', 'Fly Ash': '粉煤灰', Water: '用水量',
  Superplasticizer: '减水剂', 'Coarse Aggregate': '粗骨料', 'Fine Aggregate': '细骨料', Age: '养护龄期',
  'Concrete compressive strength': '混凝土抗压强度', fixed_acidity: '固定酸度', volatile_acidity: '挥发酸度',
  citric_acid: '柠檬酸', residual_sugar: '残糖含量', chlorides: '氯化物', free_sulfur_dioxide: '游离二氧化硫',
  total_sulfur_dioxide: '总二氧化硫', density: '密度', pH: '酸碱度', sulphates: '硫酸盐', alcohol: '酒精度',
  quality: '质量评分', color: '颜色', Area: '面积', Perimeter: '轮廓周长', Major_Axis_Length: '长轴长度',
  Minor_Axis_Length: '短轴长度', Eccentricity: '离心率', Convex_Area: '凸包面积', Extent: '范围占比', Class: '类别',
  MajorAxisLength: '长轴长度', MinorAxisLength: '短轴长度', ConvexArea: '凸包面积',
};

// This expanded baseline has been adapted after viewing the benchmark tasks.
// Publish its vocabulary and report it as such, rather than a held-out baseline.
export const synonymGroups = [
  ['sepal_length', 'sepal length', '萼片长度'], ['flower_petal_width', 'petal width', '花瓣宽度'],
  ['total_phenols', 'Total_phenols', '总酚含量'], ['colour_strength', 'Color_intensity', '色泽强度'],
  ['shell_diameter', 'Diameter', '直径'], ['dry_shell_mass', 'Shell_weight', '壳重'],
  ['refractive_index', 'RI', '折射率'], ['sodium', 'Na', '钠含量'],
  ['frequency', '声学频率'], ['air_speed', 'free-stream-velocity', '来流速度'],
  ['age', '养护龄期'], ['compression_strength', 'Concrete compressive strength', '混凝土抗压强度'],
  ['residual_sugar', '残糖含量'], ['ethanol_content', 'alcohol', '酒精度'], ['density', '密度'],
  ['free_so2', 'free_sulfur_dioxide', '游离二氧化硫'], ['perimeter', 'outline_length', '轮廓周长'],
  ['major_axis_length', 'MajorAxisLength', '长轴长度'], ['area', '面积'],
];

const normalize = name => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function dictionaryMappings(headers, request) {
  return request.fields.flatMap(({name, unit}) => {
    if (unit) return [];
    const aliases = new Set([normalize(name), ...synonymGroups.filter(group => group.some(alias => normalize(alias) === normalize(name)))
      .flatMap(group => group.map(normalize))]);
    const hits = headers.filter(header => aliases.has(normalize(header)));
    return hits.length === 1 ? [{target: name, source: hits[0], sourceUnit: '', evidence: 1, rationale: '开发集适配的公开同义词词典唯一命中'}] : [];
  });
}
