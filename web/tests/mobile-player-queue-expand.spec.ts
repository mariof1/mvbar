import {test,expect} from '@playwright/test';
for (const input of ['touch', 'mouse']) test(input + ': one vertical gesture expands queue, returns after selection, then minimizes',async({page})=>{
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
  if (input === 'mouse') { await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x,y+dy,{steps:10}); await page.mouse.up(); return; }
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let step=1;step<=10;step++) await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*step/10}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }

 await expect(page.getByRole('button',{name:'Expand queue',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Minimize player',exact:true})).toHaveCount(0);
 const title=full.locator('h2');const b=await title.boundingBox();
 const x=b!.x+b!.width/2, y=b!.y+b!.height/2;
 // Hold, reverse direction, then release close to the original player position.
 if(input==='mouse') { await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x,y-200,{steps:10}); }
 else { await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]}); await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-200}]}); }
 await expect.poll(()=>full.evaluate(el=>Math.round(el.scrollTop))).toBe(200);
 await expect(page.locator('[data-mobile-queue-expanded="false"]')).toBeVisible();
 if(input==='mouse') await page.mouse.move(x,y-40,{steps:8});
 else await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-40}]});
 await expect.poll(()=>full.evaluate(el=>Math.round(el.scrollTop))).toBe(40);
 if(input==='mouse') await page.mouse.up(); else await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await expect.poll(()=>full.evaluate(el=>el.scrollTop)).toBe(0);
 await swipe(x,y,-300);
 const section=page.locator('[data-mobile-queue-expanded="true"]');await expect(section).toBeVisible();
 await expect.poll(async()=>Math.round((await section.boundingBox())!.y)).toBe(211);
 const list=page.getByLabel('Track queue');await list.evaluate(el=>{el.scrollTop=el.scrollHeight});
 await expect(list.getByText('Queue test 30',{exact:true})).toBeInViewport();
 await page.waitForTimeout(550); // A swipe must not accidentally activate a queue row on release.
 await list.getByText('Queue test 30',{exact:true}).click();
 await expect(title).toHaveText('Queue test 30');
 await swipe(180,230,500);
 await expect(page.locator('[data-mobile-queue-expanded="false"]')).toBeVisible();
 await expect.poll(()=>full.evaluate(el=>el.scrollTop)).toBe(0);
 await expect(title).toHaveText('Queue test 30');
 const restored=await title.boundingBox();
 const backdrop=page.locator('[data-mobile-player-backdrop]');
 const startX=restored!.x+20,startY=restored!.y+10;
 const alpha=()=>backdrop.evaluate(el=>Number(getComputedStyle(el).backgroundColor.split(',').pop()!.replace(')','')));
 if(input==='mouse') { await page.mouse.move(startX,startY);await page.mouse.down();await page.mouse.move(startX,startY+80,{steps:8}); }
 else { await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y:startY}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX,y:startY+80}]}); }
 await expect.poll(alpha).toBeLessThan(0.9);
 await expect.poll(alpha).toBeGreaterThan(0.75);
 await expect.poll(()=>backdrop.evaluate(el=>parseFloat(getComputedStyle(el).backdropFilter.replace('blur(','')))).toBeGreaterThan(30);
 if(input==='mouse') await page.mouse.move(startX,startY+20,{steps:6});
 else await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX,y:startY+20}]});
 await expect.poll(alpha).toBeGreaterThan(0.85);
 if(input==='mouse') await page.mouse.up();else await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await expect.poll(alpha).toBe(0.95);
 await swipe(restored!.x+20,restored!.y+10,25);
 await expect(full).toBeVisible();
 await expect.poll(()=>full.evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).m42)).toBe(0);
 await swipe(restored!.x+20,restored!.y+10,110);
 await expect(full).toHaveCount(0);
 await expect(page.locator('.fixed.bottom-0').getByText('Queue test 30',{exact:true})).toBeVisible();
});
