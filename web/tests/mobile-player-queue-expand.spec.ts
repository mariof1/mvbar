import {test,expect} from '@playwright/test';
test('mobile player expands queue to three quarters and returns without changing track',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.routeWebSocket('**/*',()=>{});
 const tracks=Array.from({length:30},(_,i)=>({id:i+1,title:`Queue test ${i+1}`,artist:'Fixture',duration_ms:180000}));
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path.endsWith('/auth/me')?{ok:true,user:{id:'test',role:'admin',email:'test@local'}}:path.endsWith('/favorites')?{ok:true,tracks,total:30}:{ok:true,tracks:[],artists:[],albums:[],playlists:[],devices:[],searches:[]}})});
 await page.goto(`${process.env.MVBAR_TEST_URL||'http://localhost:8080'}/#/favorites`);
 await page.getByRole('button',{name:'Play all',exact:true}).click();
 await page.locator('.fixed.bottom-0').getByText('Queue test 1',{exact:true}).click();
 const full=page.locator('[data-mobile-full-player]');await expect(full).toBeVisible();

 const touch=await page.context().newCDPSession(page);
 async function swipe(x:number,y:number,dy:number) {
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let step=1;step<=10;step++) await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*step/10}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }
 await expect(page.getByRole('button',{name:'Expand queue',exact:true})).toHaveCount(0);
 let attempt=0;
 for (const target of [full.locator('h2'),full.getByRole('button',{name:'Play',exact:true}),full.locator('[data-mobile-queue-index="0"]')]) {
  await target.scrollIntoViewIfNeeded();const b=await target.boundingBox();
  await swipe(b!.x+b!.width/2,b!.y+b!.height/2,-110);
  const section=page.locator('[data-mobile-queue-expanded="true"]');await expect(section).toBeVisible();
  await expect.poll(async()=>{const b=await section.boundingBox();return Math.abs(b!.y-211)<6&&Math.abs(b!.height-633)<6}).toBe(true);
  const list=page.getByLabel('Track queue');await list.evaluate(el=>{el.scrollTop=el.scrollHeight});
  await expect(list.getByText('Queue test 30',{exact:true})).toBeInViewport();
  // A downward swipe on the compact player returns to artwork and transport.
  await swipe(180,attempt++ % 2 === 0 ? 170 : 230,90);
  await expect(page.locator('[data-mobile-queue-expanded="false"]')).toBeVisible();
  await expect.poll(()=>full.evaluate(el=>el.scrollTop)).toBe(0);
  await expect(full.locator('h2')).toHaveText('Queue test 1');
 }
});

