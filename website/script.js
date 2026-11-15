document.documentElement.classList.add('js');
(function(){
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* nav + progress */
  var nav=document.querySelector('.nav'),bar=document.querySelector('.progress');
  function onScroll(){
    var y=window.scrollY,max=document.documentElement.scrollHeight-innerHeight;
    if(nav)nav.classList.toggle('scrolled',y>10);
    if(bar)bar.style.transform='scaleX('+(max>0?y/max:0)+')';
  }
  addEventListener('scroll',onScroll,{passive:true});onScroll();

  /* split headings into words */
  document.querySelectorAll('.split').forEach(function(el){
    var words=el.textContent.trim().split(/\s+/);el.textContent='';
    words.forEach(function(w,i){
      var s=document.createElement('span');s.className='w';s.style.setProperty('--i',i);s.textContent=w;
      el.appendChild(s);if(i<words.length-1)el.appendChild(document.createTextNode(' '));
    });
  });

  /* reveal */
  var els=document.querySelectorAll('.reveal,.split');
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.15});
    els.forEach(function(e){io.observe(e)});
  }else els.forEach(function(e){e.classList.add('in')});

  /* statement beats light up as they pass the middle of the screen */
  var beats=document.querySelectorAll('.beat');
  if('IntersectionObserver' in window&&!reduce){
    var bo=new IntersectionObserver(function(es){es.forEach(function(e){
      if(e.isIntersecting||e.boundingClientRect.top<0){e.target.classList.add('on');bo.unobserve(e.target)}
    })},{rootMargin:'0px 0px -38% 0px'});
    beats.forEach(function(e){bo.observe(e)});
  }else beats.forEach(function(e){e.classList.add('on')});

  /* rail */
  var links=document.querySelectorAll('.rail a');
  if(links.length&&'IntersectionObserver' in window){
    var ro=new IntersectionObserver(function(es){es.forEach(function(e){
      if(e.isIntersecting)links.forEach(function(l){l.classList.toggle('on',l.getAttribute('href')==='#'+e.target.id)})
    })},{rootMargin:'-45% 0px -50% 0px'});
    document.querySelectorAll('main section[id]').forEach(function(s){ro.observe(s)});
  }

  /* offline queue simulation (illustrative) */
  var sim=document.getElementById('sim');
  if(sim){
    var logs={A:sim.querySelector('#logA'),B:sim.querySelector('#logB')},
        wire=sim.querySelector('.wire'),tog=sim.querySelector('#toggle'),
        status=sim.querySelector('#simStatus'),online=true,pending={A:[],B:[]},n=0,
        types=['goal','decision','task','progress','question'];
    function add(side,text,queued){
      var li=document.createElement('li'),sp=document.createElement('span');
      sp.textContent=text;li.appendChild(sp);
      if(queued){var em=document.createElement('em');em.textContent='queued locally';li.appendChild(em)}
      logs[side].appendChild(li);
      while(logs[side].children.length>5)logs[side].removeChild(logs[side].firstChild);
      return li;
    }
    function say(){
      var qa=pending.A.length,qb=pending.B.length;
      status.textContent=online
        ?'Connected. Updates appear on both laptops.'
        :'Link down. Each laptop still has its own local context. Queued: '+qa+' on A, '+qb+' on B. Cloud models still need connectivity.';
    }
    function send(from){
      var to=from==='A'?'B':'A',t=types[n++%types.length],text='[Sample '+t+' from '+from+']';
      if(online){add(from,text);add(to,text)}
      else{pending[from].push({text:text,li:add(from,text,true)})}
      say();
    }
    function flush(){
      ['A','B'].forEach(function(from){
        var to=from==='A'?'B':'A',q=pending[from];pending[from]=[];
        q.forEach(function(p,i){setTimeout(function(){
          var em=p.li.querySelector('em');if(em)em.remove();add(to,p.text);
        },reduce?0:i*350)});
      });
    }
    tog.addEventListener('click',function(){
      online=!online;tog.setAttribute('aria-pressed',String(!online));
      tog.textContent=online?'Disconnect':'Reconnect';
      wire.classList.toggle('off',!online);
      if(online){flush();status.textContent='Reconnected. Missed updates are replaying in both directions.';setTimeout(say,1800)}else say();
    });
    sim.querySelector('#sendA').addEventListener('click',function(){send('A')});
    sim.querySelector('#sendB').addEventListener('click',function(){send('B')});
    say();
  }
})();
