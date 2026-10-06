document.getElementById('grid').innerHTML=CONCEPTS.map(c=>`<article><a href="${c.slug}.html" aria-label="${c.id} ${c.name} 열기"><iframe src="${c.slug}.html?thumb" tabindex="-1" title="${c.name} 미리보기"></iframe><h2><b>${c.id}</b>${c.name}<small>${c.en}</small></h2></a></article>`).join('');
function fitOverview(){const s=Math.min(innerWidth/1440,innerHeight/1070);document.getElementById('sheet').style.transform=`translate(${-720*s}px,${-535*s}px) scale(${s})`;}
fitOverview();addEventListener('resize',fitOverview);
