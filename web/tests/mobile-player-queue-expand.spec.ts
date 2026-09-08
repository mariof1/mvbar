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
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:220}]});
 for(let y=207;y>=90;y-=13) await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:190,y}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 const section=page.locator('[data-mobile-queue-expanded="true"]');await expect(section).toBeVisible();
 await expect.poll(async()=>{const b=await section.boundingBox();return Math.abs(b!.y-211)<6&&Math.abs(b!.height-633)<6}).toBe(true);
 await page.screenshot({path:'../.local/mobile-expanded-queue.png'});
 const list=page.getByLabel('Track queue');await list.evaluate(el=>{el.scrollTop=el.scrollHeight});await expect(list.getByText('Queue test 30',{exact:true})).toBeInViewport();
 await full.getByRole('button',{name:'Collapse queue',exact:true}).click();
 await expect(page.locator('[data-mobile-queue-expanded="false"]')).toBeVisible();
 await expect.poll(()=>full.evaluate(el=>el.scrollTop)).toBe(0);
 await expect(full.locator('h2')).toHaveText('Queue test 1');
 await full.getByRole('button',{name:'Expand queue',exact:true}).click();
 await expect.poll(async()=>Math.round((await section.boundingBox())!.y)).toBe(211);
 await page.mouse.move(80,230);await page.mouse.down();await page.mouse.move(80,320,{steps:8});await page.mouse.up();
 await expect(page.locator('[data-mobile-queue-expanded="false"]')).toBeVisible();
 await expect.poll(()=>full.evaluate(el=>el.scrollTop)).toBe(0);
});

