const rewards = require('./story-rewards');
const INGREDIENTS = [
  { id: 'tomato', name: '西红柿', icon: '🍅' }, { id: 'egg', name: '鸡蛋', icon: '🥚' },
  { id: 'fish', name: '鱼', icon: '🐟' }, { id: 'carrot', name: '胡萝卜', icon: '🥕' },
  { id: 'potato', name: '土豆', icon: '🥔' }, { id: 'rice', name: '米饭', icon: '🍚' }
];
const RECIPES = [
  { id: 'tomato-egg', name: '西红柿炒鸡蛋', icon: '🍳', needs: ['tomato', 'egg'] },
  { id: 'fried-fish', name: '香香煎鱼', icon: '🐟', needs: ['fish'] },
  { id: 'vegetable-soup', name: '暖暖蔬菜汤', icon: '🍲', needs: ['carrot', 'potato'] },
  { id: 'egg-rice', name: '金黄蛋炒饭', icon: '🍛', needs: ['egg', 'rice'] },
  { id: 'tomato-soup', name: '番茄鱼汤', icon: '🥣', needs: ['tomato', 'fish'] },
  { id: 'potato', name: '软软蒸土豆', icon: '🥔', needs: ['potato'] }
];
const ROOMS = [
  {id:'cozy',name:'阳光小屋',image:'/assets/rooms/cozy-v1.png'},
  { id: 'living', name: '宝石客厅', image: '/assets/rooms/living.webp' },
  { id: 'kitchen', name: '甜甜厨房', image: '/assets/rooms/kitchen.webp' },
  { id: 'bathroom', name: '泡泡浴室', image: '/assets/rooms/bathroom.webp' },
  { id: 'pink', name: '粉钻大卧室', image: '/assets/rooms/pink.webp' },
  { id: 'purple', name: '紫色中卧室', image: '/assets/rooms/purple.webp' },
  { id: 'blue', name: '蓝色小卧室', image: '/assets/rooms/blue.webp' }
];
const CUSTOM_ROOMS = [
  ROOMS[0],
  {id:'living',name:'客厅',image:'/assets/rooms/neutral-v1/living.webp'},
  {id:'kitchen',name:'厨房',image:'/assets/rooms/neutral-v1/kitchen.webp'},
  {id:'bathroom',name:'浴室',image:'/assets/rooms/neutral-v1/bathroom.webp'},
  {id:'bedroom',name:'卧室',image:'/assets/rooms/neutral-v1/bedroom.webp'}
];
function roomsFor(state){return state.petProfile&&!state.petProfile.legacyRules?CUSTOM_ROOMS:ROOMS;}
function selectedRoom(state){const rooms=roomsFor(state);if(rooms.some(r=>r.id===state.room))return state.room;return state.petProfile&&['pink','purple','blue'].includes(state.room)?'bedroom':rooms[0].id;}
function migrate(state) {
  // Restore kitchen credits without converting or reissuing previously granted food.
  if(state.taskRewardMode==='food')state.taskRewardMode='ingredients';
  if (!state.homeVersion) {
    // Previously claimed strawberries stay edible; spent reading rewards cannot be claimed twice.
    state.rewardSpent = state.claimedRewards * 2;
    state.ingredients = {}; state.dishes = {}; state.room = 'living';
    state.birthday = null; state.birthdayYears = []; state.homeVersion = 1;
  }
  rewards.migrate(state);
}
// 读完一本书就发一次出门的力气：当天只发一次，用掉后不补。
// 喂饭只负责喂饱肚子和成长，和串门机会脱钩。
function grantVisitCredit(state, now = new Date()) {
  const day = chinaDate(now);
  if (state.visitCredit && state.visitCredit.day === day) return false;
  state.visitCredit = { day, left: 1 };
  return true;
}
function available(state) { return rewards.available(state); }
function totalFood(state) { return (state.food || 0) + Object.values(state.dishes || {}).reduce((a, b) => a + b, 0) + INGREDIENTS.reduce((sum, item) => sum + (state.ingredients?.[item.id] || 0), 0); }
function chinaDate(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
function birthdayView(state, now) {
  const date = chinaDate(now), year = Number(date.slice(0, 4));
  // Leap-day birthdays celebrate on February 28 in non-leap years.
  const expected = state.birthday === '02-29' && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1 ? '02-28' : state.birthday;
  return { date: state.birthday, today: date.slice(5) === expected, celebrated: state.birthdayYears.includes(year), year };
}
function view(state) {
  return { ingredients: INGREDIENTS, recipes: RECIPES, rooms: roomsFor(state), roomId: selectedRoom(state), available: available(state), storyRewards: rewards.daily(state), totalFood: totalFood(state), birthday: birthdayView(state), wish: RECIPES[state.feeds % RECIPES.length] };
}
function fail(message) { const e = new Error(message); e.status = 409; throw e; }
function action(state, kind, body) {
  if (kind === 'claim') {
    const ids = body.ingredients;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => !INGREDIENTS.some(i => i.id === id))) fail('先选想要的食材吧。');
    if (ids.length > available(state)) fail('食材额度还不够，先讲一个故事并保存吧。');
    rewards.spend(state,ids.length);
    for (const id of ids) state.ingredients[id] = (state.ingredients[id] || 0) + 1;
    state.rewardSpent += ids.length;
  } else if (kind === 'cook') {
    const recipe = RECIPES.find(r => r.id === body.recipe);
    if (!recipe) fail('先选一道菜吧。');
    const missing = recipe.needs.filter(id => !state.ingredients[id]);
    if (missing.length) fail('还缺' + missing.map(id => INGREDIENTS.find(i => i.id === id).name).join('、') + '，领好食材再来做。');
    for (const id of recipe.needs) state.ingredients[id]--;
    state.dishes[recipe.id] = (state.dishes[recipe.id] || 0) + 1;
  } else if (kind === 'feed') {
    let feedCount = 1;
    if (body.ingredient !== undefined) {
      if (body.dish || !INGREDIENTS.some(item => item.id === body.ingredient)) fail('选一种背包里的食材吧。');
      if (!(state.ingredients[body.ingredient] > 0)) fail('这个食材已经吃完啦。');
      state.ingredients[body.ingredient]--;
    } else if (body.dish === 'strawberry') {
      if (!(state.food > 0)) fail('草莓已经吃完啦。');
      state.food--;
    } else {
      const recipe = RECIPES.find(item => item.id === body.dish || !body.dish && state.dishes[item.id] > 0);
      if (recipe && state.dishes[recipe.id] > 0) {
        state.dishes[recipe.id]--;
        feedCount = recipe.needs.length;
      } else if (!body.dish && state.food > 0) {
        state.food--;
      } else if (!body.dish) {
        const ingredient = INGREDIENTS.find(item => state.ingredients[item.id] > 0);
        if (!ingredient) fail('背包里还没有食物，先领一个食材吧。');
        state.ingredients[ingredient.id]--;
      } else fail('这道菜已经吃完啦，选另一份食物吧。');
    }
    state.feeds += feedCount;
    state.lastFedAt = Date.now();
  } else if (kind === 'room') {
    if (!roomsFor(state).some(r => r.id === body.room)) fail('这个房间还没有找到。'); state.room = body.room;
  } else if (kind === 'birthday') {
    if (!/^\d{2}-\d{2}$/.test(body.date || '')) fail('选一下生日的月份和日期吧。');
    const [month, day] = body.date.split('-').map(Number), d = new Date(Date.UTC(2000, month - 1, day));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) fail('这个生日日期不存在，重新选一下吧。');
    state.birthday = body.date;
  } else if (kind === 'celebrate') {
    const birthday = birthdayView(state);
    if (!birthday.today) fail('还没到生日呢，生日那天再一起吹蜡烛吧。');
    if (birthday.celebrated) fail('今年已经一起吹过蜡烛啦！');
    state.birthdayYears.push(birthday.year);
  }
}
module.exports = { INGREDIENTS, RECIPES, ROOMS, CUSTOM_ROOMS, roomsFor, selectedRoom, migrate, available, totalFood, view, action, birthdayView, grantVisitCredit };
