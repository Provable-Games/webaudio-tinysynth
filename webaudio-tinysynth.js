/*
 * webaudio-tinysynth by Tatsuya Shinyagaito (g200kg)
 * https://github.com/g200kg/webaudio-tinysynth - Apache License 2.0
 *
 * Modified by Provable Games (https://github.com/Provable-Games/webaudio-tinysynth);
 * see NOTICE for the changes.
 */
( function(window){
"use strict";

/* A lifecycle Error whose message is its stable code (D-013, D-018). */
function CodedError(code){
  const e=new Error(code);
  e.code=code;
  return e;
}

/* Built-in buffers (#7, D-004), generation version 1 (bufferVersion): the reverb impulse
   (convBuf), white noise (n0) and metallic noise (n1) are generated from the seed, never
   from Math.random. Each buffer has its own mulberry32 stream: stream k (convBuf 0, n0 1,
   n1 2) starts at state seed+k*2^30, which is the seed's sequence 2^30*k draws on, so
   the streams never overlap and no buffer's samples depend on another's. The same seed,
   version and sample rate give the same Float32 data. Any change to the generated data
   must increment the version. */
function mulberry32(a){
  return ()=>{
    a=a+0x6d2b79f5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

function WebAudioTinySynthCore(target) {
  Object.assign(target,{
    properties:{
      masterVol:  {type:Number, value:0.5, observer:"setMasterVol"},
      reverbLev:  {type:Number, value:0.3, observer:"setReverbLev"},
      quality:    {type:Number, value:1, observer:"setQuality"},
      debug:      {type:Number, value:0},
      src:        {type:String, value:null, observer:"loadMIDIfromSrc"},
      loop:       {type:Number, value:0},
      loopEnd:    {type:Number, value:0},
      internalcontext: {type:Number, value:1},
      tsmode:     {type:Number, value:0},
      voices:     {type:Number, value:64},
      useReverb:  {type:Number, value:1},
    },
    program:[
// 1-8 : Piano
      {name:"Acoustic Grand Piano"},    {name:"Bright Acoustic Piano"},
      {name:"Electric Grand Piano"},    {name:"Honky-tonk Piano"},
      {name:"Electric Piano 1"},        {name:"Electric Piano 2"},
      {name:"Harpsichord"},             {name:"Clavi"},
/* 9-16 : Chromatic Perc*/
      {name:"Celesta"},                 {name:"Glockenspiel"},
      {name:"Music Box"},               {name:"Vibraphone"},
      {name:"Marimba"},                 {name:"Xylophone"},
      {name:"Tubular Bells"},           {name:"Dulcimer"},
/* 17-24 : Organ */
      {name:"Drawbar Organ"},           {name:"Percussive Organ"},
      {name:"Rock Organ"},              {name:"Church Organ"},
      {name:"Reed Organ"},              {name:"Accordion"},
      {name:"Harmonica"},               {name:"Tango Accordion"},
/* 25-32 : Guitar */
      {name:"Acoustic Guitar (nylon)"}, {name:"Acoustic Guitar (steel)"},
      {name:"Electric Guitar (jazz)"},  {name:"Electric Guitar (clean)"},
      {name:"Electric Guitar (muted)"}, {name:"Overdriven Guitar"},
      {name:"Distortion Guitar"},       {name:"Guitar harmonics"},
/* 33-40 : Bass */
      {name:"Acoustic Bass"},           {name:"Electric Bass (finger)"},
      {name:"Electric Bass (pick)"},    {name:"Fretless Bass"},
      {name:"Slap Bass 1"},             {name:"Slap Bass 2"},
      {name:"Synth Bass 1"},            {name:"Synth Bass 2"},
/* 41-48 : Strings */
      {name:"Violin"},                  {name:"Viola"},
      {name:"Cello"},                   {name:"Contrabass"},
      {name:"Tremolo Strings"},         {name:"Pizzicato Strings"},
      {name:"Orchestral Harp"},         {name:"Timpani"},
/* 49-56 : Ensamble */
      {name:"String Ensemble 1"},       {name:"String Ensemble 2"},
      {name:"SynthStrings 1"},          {name:"SynthStrings 2"},
      {name:"Choir Aahs"},              {name:"Voice Oohs"},
      {name:"Synth Voice"},             {name:"Orchestra Hit"},
/* 57-64 : Brass */
      {name:"Trumpet"},                 {name:"Trombone"},
      {name:"Tuba"},                    {name:"Muted Trumpet"},
      {name:"French Horn"},             {name:"Brass Section"},
      {name:"SynthBrass 1"},            {name:"SynthBrass 2"},
/* 65-72 : Reed */
      {name:"Soprano Sax"},             {name:"Alto Sax"},
      {name:"Tenor Sax"},               {name:"Baritone Sax"},
      {name:"Oboe"},                    {name:"English Horn"},
      {name:"Bassoon"},                 {name:"Clarinet"},
/* 73-80 : Pipe */
      {name:"Piccolo"},                 {name:"Flute"},
      {name:"Recorder"},                {name:"Pan Flute"},
      {name:"Blown Bottle"},            {name:"Shakuhachi"},
      {name:"Whistle"},                 {name:"Ocarina"},
/* 81-88 : SynthLead */
      {name:"Lead 1 (square)"},         {name:"Lead 2 (sawtooth)"},
      {name:"Lead 3 (calliope)"},       {name:"Lead 4 (chiff)"},
      {name:"Lead 5 (charang)"},        {name:"Lead 6 (voice)"},
      {name:"Lead 7 (fifths)"},         {name:"Lead 8 (bass + lead)"},
/* 89-96 : SynthPad */
      {name:"Pad 1 (new age)"},         {name:"Pad 2 (warm)"},
      {name:"Pad 3 (polysynth)"},       {name:"Pad 4 (choir)"},
      {name:"Pad 5 (bowed)"},           {name:"Pad 6 (metallic)"},
      {name:"Pad 7 (halo)"},            {name:"Pad 8 (sweep)"},
/* 97-104 : FX */
      {name:"FX 1 (rain)"},             {name:"FX 2 (soundtrack)"},
      {name:"FX 3 (crystal)"},          {name:"FX 4 (atmosphere)"},
      {name:"FX 5 (brightness)"},       {name:"FX 6 (goblins)"},
      {name:"FX 7 (echoes)"},           {name:"FX 8 (sci-fi)"},
/* 105-112 : Ethnic */
      {name:"Sitar"},                   {name:"Banjo"},
      {name:"Shamisen"},                {name:"Koto"},
      {name:"Kalimba"},                 {name:"Bag pipe"},
      {name:"Fiddle"},                  {name:"Shanai"},
/* 113-120 : Percussive */
      {name:"Tinkle Bell"},             {name:"Agogo"},
      {name:"Steel Drums"},             {name:"Woodblock"},
      {name:"Taiko Drum"},              {name:"Melodic Tom"},
      {name:"Synth Drum"},              {name:"Reverse Cymbal"},
/* 121-128 : SE */
      {name:"Guitar Fret Noise"},       {name:"Breath Noise"},
      {name:"Seashore"},                {name:"Bird Tweet"},
      {name:"Telephone Ring"},          {name:"Helicopter"},
      {name:"Applause"},                {name:"Gunshot"},
    ],
    drummap:[
// 35
      {name:"Acoustic Bass Drum"},  {name:"Bass Drum 1"},      {name:"Side Stick"},     {name:"Acoustic Snare"},
      {name:"Hand Clap"},           {name:"Electric Snare"},   {name:"Low Floor Tom"},  {name:"Closed Hi Hat"},
      {name:"High Floor Tom"},      {name:"Pedal Hi-Hat"},     {name:"Low Tom"},        {name:"Open Hi-Hat"},
      {name:"Low-Mid Tom"},         {name:"Hi-Mid Tom"},       {name:"Crash Cymbal 1"}, {name:"High Tom"},
      {name:"Ride Cymbal 1"},       {name:"Chinese Cymbal"},   {name:"Ride Bell"},      {name:"Tambourine"},
      {name:"Splash Cymbal"},       {name:"Cowbell"},          {name:"Crash Cymbal 2"}, {name:"Vibraslap"},
      {name:"Ride Cymbal 2"},       {name:"Hi Bongo"},         {name:"Low Bongo"},      {name:"Mute Hi Conga"},
      {name:"Open Hi Conga"},       {name:"Low Conga"},        {name:"High Timbale"},   {name:"Low Timbale"},
      {name:"High Agogo"},          {name:"Low Agogo"},        {name:"Cabasa"},         {name:"Maracas"},
      {name:"Short Whistle"},       {name:"Long Whistle"},     {name:"Short Guiro"},    {name:"Long Guiro"},
      {name:"Claves"},              {name:"Hi Wood Block"},    {name:"Low Wood Block"}, {name:"Mute Cuica"},
      {name:"Open Cuica"},          {name:"Mute Triangle"},    {name:"Open Triangle"},
    ],
    program1:[
      // 1-8 : Piano
      [{w:"sine",v:.4,d:0.7,r:0.1,},{w:"triangle",v:3,d:0.7,s:0.1,g:1,a:0.01,k:-1.2}],
      [{w:"triangle",v:0.4,d:0.7,r:0.1,},{w:"triangle",v:4,t:3,d:0.4,s:0.1,g:1,k:-1,a:0.01,}],
      [{w:"sine",d:0.7,r:0.1,},{w:"triangle",v:4,f:2,d:0.5,s:0.5,g:1,k:-1}],
      [{w:"sine",d:0.7,v:0.2,},{w:"triangle",v:4,t:3,f:2,d:0.3,g:1,k:-1,a:0.01,s:0.5,}],
      [{w:"sine",v:0.35,d:0.7,},{w:"sine",v:3,t:7,f:1,d:1,s:1,g:1,k:-.7}],
      [{w:"sine",v:0.35,d:0.7,},{w:"sine",v:8,t:7,f:1,d:0.5,s:1,g:1,k:-.7}],
      [{w:"sawtooth",v:0.34,d:2,},{w:"sine",v:8,f:0.1,d:2,s:1,r:2,g:1,}],
      [{w:"triangle",v:0.34,d:1.5,},{w:"square",v:6,f:0.1,d:1.5,s:0.5,r:2,g:1,}],
      /* 9-16 : Chromatic Perc*/
      [{w:"sine",d:0.3,r:0.3,},{w:"sine",v:7,t:11,d:0.03,g:1,}],
      [{w:"sine",d:0.3,r:0.3,},{w:"sine",v:11,t:6,d:0.2,s:0.4,g:1,}],
      [{w:"sine",v:0.2,d:0.3,r:0.3,},{w:"sine",v:11,t:5,d:0.1,s:0.4,g:1,}],
      [{w:"sine",v:0.2,d:0.6,r:0.6,},{w:"triangle",v:11,t:5,f:1,s:0.5,g:1,}],
      [{w:"sine",v:0.3,d:0.2,r:0.2,},{w:"sine",v:6,t:5,d:0.02,g:1,}],
      [{w:"sine",v:0.3,d:0.2,r:0.2,},{w:"sine",v:7,t:11,d:0.03,g:1,}],
      [{w:"sine",v:0.2,d:1,r:1,},{w:"sine",v:11,t:3.5,d:1,r:1,g:1,}],
      [{w:"triangle",v:0.2,d:0.5,r:0.2,},{w:"sine",v:6,t:2.5,d:0.2,s:0.1,r:0.2,g:1,}],
      /* 17-24 : Organ */
      [{w:"w9999",v:0.22,s:0.9,},{w:"w9999",v:0.22,t:2,f:2,s:0.9,}],
      [{w:"w9999",v:0.2,s:1,},{w:"sine",v:11,t:6,f:2,s:0.1,g:1,h:0.006,r:0.002,d:0.002,},{w:"w9999",v:0.2,t:2,f:1,h:0,s:1,}],
      [{w:"w9999",v:0.2,d:0.1,s:0.9,},{w:"w9999",v:0.25,t:4,f:2,s:0.5,}],
      [{w:"w9999",v:0.3,a:0.04,s:0.9,},{w:"w9999",v:0.2,t:8,f:2,a:0.04,s:0.9,}],
      [{w:"sine",v:0.2,a:0.02,d:0.05,s:1,},{w:"sine",v:6,t:3,f:1,a:0.02,d:0.05,s:1,g:1,}],
      [{w:"triangle",v:0.2,a:0.02,d:0.05,s:0.8,},{w:"square",v:7,t:3,f:1,d:0.05,s:1.5,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:0.2,s:0.5,},{w:"square",v:1,d:0.03,s:2,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:0.1,s:0.8,},{w:"square",v:1,a:0.3,d:0.1,s:2,g:1,}],
      /* 25-32 : Guitar */
      [{w:"sine",v:0.3,d:0.5,f:1,},{w:"triangle",v:5,t:3,f:-1,d:1,s:0.1,g:1,}],
      [{w:"sine",v:0.4,d:0.6,f:1,},{w:"triangle",v:12,t:3,d:0.6,s:0.1,g:1,f:-1,}],
      [{w:"triangle",v:0.3,d:1,f:1,},{w:"triangle",v:6,f:-1,d:0.4,s:0.5,g:1,t:3,}],
      [{w:"sine",v:0.3,d:1,f:-1,},{w:"triangle",v:11,f:1,d:0.4,s:0.5,g:1,t:3,}],
      [{w:"sine",v:0.4,d:0.1,r:0.01},{w:"sine",v:7,g:1,}],
      [{w:"triangle",v:0.4,d:1,f:1,},{w:"square",v:4,f:-1,d:1,s:0.7,g:1,}],//[{w:"triangle",v:0.35,d:1,f:1,},{w:"square",v:7,f:-1,d:0.3,s:0.5,g:1,}],
      [{w:"triangle",v:0.35,d:1,f:1,},{w:"square",v:7,f:-1,d:0.3,s:0.5,g:1,}],//[{w:"triangle",v:0.4,d:1,f:1,},{w:"square",v:4,f:-1,d:1,s:0.7,g:1,}],//[{w:"triangle",v:0.4,d:1,},{w:"square",v:4,f:2,d:1,s:0.7,g:1,}],
      [{w:"sine",v:0.2,t:1.5,a:0.005,h:0.2,d:0.6,},{w:"sine",v:11,t:5,f:2,d:1,s:0.5,g:1,}],
      /* 33-40 : Bass */
      [{w:"sine",d:0.3,},{w:"sine",v:4,t:3,d:1,s:1,g:1,}],
      [{w:"sine",d:0.3,},{w:"sine",v:4,t:3,d:1,s:1,g:1,}],
      [{w:"w9999",d:0.3,v:0.7,s:0.5,},{w:"sawtooth",v:1.2,d:0.02,s:0.5,g:1,h:0,r:0.02,}],
      [{w:"sine",d:0.3,},{w:"sine",v:4,t:3,d:1,s:1,g:1,}],
      [{w:"triangle",v:0.3,t:2,d:1,},{w:"triangle",v:15,t:2.5,d:0.04,s:0.1,g:1,}],
      [{w:"triangle",v:0.3,t:2,d:1,},{w:"triangle",v:15,t:2.5,d:0.04,s:0.1,g:1,}],
      [{w:"triangle",d:0.7,},{w:"square",v:0.4,t:0.5,f:1,d:0.2,s:10,g:1,}],
      [{w:"triangle",d:0.7,},{w:"square",v:0.4,t:0.5,f:1,d:0.2,s:10,g:1,}],
      /* 41-48 : Strings */
      [{w:"sawtooth",v:0.4,a:0.1,d:11,},{w:"sine",v:5,d:11,s:0.2,g:1,}],
      [{w:"sawtooth",v:0.4,a:0.1,d:11,},{w:"sine",v:5,d:11,s:0.2,g:1,}],
      [{w:"sawtooth",v:0.4,a:0.1,d:11,},{w:"sine",v:5,t:0.5,d:11,s:0.2,g:1,}],
      [{w:"sawtooth",v:0.4,a:0.1,d:11,},{w:"sine",v:5,t:0.5,d:11,s:0.2,g:1,}],
      [{w:"sine",v:0.4,a:0.1,d:11,},{w:"sine",v:6,f:2.5,d:0.05,s:1.1,g:1,}],
      [{w:"sine",v:0.3,d:0.1,r:0.1,},{w:"square",v:4,t:3,d:1,s:0.2,g:1,}],
      [{w:"sine",v:0.3,d:0.5,r:0.5,},{w:"sine",v:7,t:2,f:2,d:1,r:1,g:1,}],
      [{w:"triangle",v:0.6,h:0.03,d:0.3,r:0.3,t:0.5,},{w:"n0",v:8,t:1.5,d:0.08,r:0.08,g:1,}],
      /* 49-56 : Ensamble */
      [{w:"sawtooth",v:0.3,a:0.03,s:0.5,},{w:"sawtooth",v:0.2,t:2,f:2,d:1,s:2,}],
      [{w:"sawtooth",v:0.3,f:-2,a:0.03,s:0.5,},{w:"sawtooth",v:0.2,t:2,f:2,d:1,s:2,}],
      [{w:"sawtooth",v:0.2,a:0.02,s:1,},{w:"sawtooth",v:0.2,t:2,f:2,a:1,d:1,s:1,}],
      [{w:"sawtooth",v:0.2,a:0.02,s:1,},{w:"sawtooth",v:0.2,f:2,a:0.02,d:1,s:1,}],
      [{w:"triangle",v:0.3,a:0.03,s:1,},{w:"sine",v:3,t:5,f:1,d:1,s:1,g:1,}],
      [{w:"sine",v:0.4,a:0.03,s:0.9,},{w:"sine",v:1,t:2,f:3,d:0.03,s:0.2,g:1,}],
      [{w:"triangle",v:0.6,a:0.05,s:0.5,},{w:"sine",v:1,f:0.8,d:0.2,s:0.2,g:1,}],
      [{w:"square",v:0.15,a:0.01,d:0.2,r:0.2,t:0.5,h:0.03,},{w:"square",v:4,f:0.5,d:0.2,r:11,a:0.01,g:1,h:0.02,},{w:"square",v:0.15,t:4,f:1,a:0.02,d:0.15,r:0.15,h:0.03,},{g:3,w:"square",v:4,f:-0.5,a:0.01,h:0.02,d:0.15,r:11,}],
      /* 57-64 : Brass */
      [{w:"square",v:0.2,a:0.01,d:1,s:0.6,r:0.04,},{w:"sine",v:1,d:0.1,s:4,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:1,s:0.5,r:0.08,},{w:"sine",v:1,d:0.1,s:4,g:1,}],
      [{w:"square",v:0.2,a:0.04,d:1,s:0.4,r:0.08,},{w:"sine",v:1,d:0.1,s:4,g:1,}],
      [{w:"square",v:0.15,a:0.04,s:1,},{w:"sine",v:2,d:0.1,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:1,s:0.5,r:0.08,},{w:"sine",v:1,d:0.1,s:4,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:1,s:0.6,r:0.08,},{w:"sine",v:1,f:0.2,d:0.1,s:4,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:0.5,s:0.7,r:0.08,},{w:"sine",v:1,d:0.1,s:4,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:1,s:0.5,r:0.08,},{w:"sine",v:1,d:0.1,s:4,g:1,}],
      /* 65-72 : Reed */
      [{w:"square",v:0.2,a:0.02,d:2,s:0.6,},{w:"sine",v:2,d:1,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:2,s:0.6,},{w:"sine",v:2,d:1,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:1,s:0.6,},{w:"sine",v:2,d:1,g:1,}],
      [{w:"square",v:0.2,a:0.02,d:1,s:0.6,},{w:"sine",v:2,d:1,g:1,}],
      [{w:"sine",v:0.4,a:0.02,d:0.7,s:0.5,},{w:"square",v:5,t:2,d:0.2,s:0.5,g:1,}],
      [{w:"sine",v:0.3,a:0.05,d:0.2,s:0.8,},{w:"sawtooth",v:6,f:0.1,d:0.1,s:0.3,g:1,}],
      [{w:"sine",v:0.3,a:0.03,d:0.2,s:0.4,},{w:"square",v:7,f:0.2,d:1,s:0.1,g:1,}],
      [{w:"square",v:0.2,a:0.05,d:0.1,s:0.8,},{w:"square",v:4,d:0.1,s:1.1,g:1,}],
      /* 73-80 : Pipe */
      [{w:"sine",a:0.02,d:2,},{w:"sine",v:6,t:2,d:0.04,g:1,}],
      [{w:"sine",v:0.7,a:0.03,d:0.4,s:0.4,},{w:"sine",v:4,t:2,f:0.2,d:0.4,g:1,}],
      [{w:"sine",v:0.7,a:0.02,d:0.4,s:0.6,},{w:"sine",v:3,t:2,d:0,s:1,g:1,}],
      [{w:"sine",v:0.4,a:0.06,d:0.3,s:0.3,},{w:"sine",v:7,t:2,d:0.2,s:0.2,g:1,}],
      [{w:"sine",a:0.02,d:0.3,s:0.3,},{w:"sawtooth",v:3,t:2,d:0.3,g:1,}],
      [{w:"sine",v:0.4,a:0.02,d:2,s:0.1,},{w:"sawtooth",v:8,t:2,f:1,d:0.5,g:1,}],
      [{w:"sine",v:0.7,a:0.03,d:0.5,s:0.3,},{w:"sine",v:0.003,t:0,f:4,d:0.1,s:0.002,g:1,}],
      [{w:"sine",v:0.7,a:0.02,d:2,},{w:"sine",v:1,t:2,f:1,d:0.02,g:1,}],
      /* 81-88 : SynthLead */
      [{w:"square",v:0.3,d:1,s:0.5,},{w:"square",v:1,f:0.2,d:1,s:0.5,g:1,}],
      [{w:"sawtooth",v:0.3,d:2,s:0.5,},{w:"square",v:2,f:0.1,s:0.5,g:1,}],
      [{w:"triangle",v:0.5,a:0.05,d:2,s:0.6,},{w:"sine",v:4,t:2,g:1,}],
      [{w:"triangle",v:0.3,a:0.01,d:2,s:0.3,},{w:"sine",v:22,t:2,f:1,d:0.03,s:0.2,g:1,}],
      [{w:"sawtooth",v:0.3,d:1,s:0.5,},{w:"sine",v:11,t:11,a:0.2,d:0.05,s:0.3,g:1,}],
      [{w:"sine",v:0.3,a:0.06,d:1,s:0.5,},{w:"sine",v:7,f:1,d:1,s:0.2,g:1,}],
      [{w:"sawtooth",v:0.3,a:0.03,d:0.7,s:0.3,r:0.2,},{w:"sawtooth",v:0.3,t:0.75,d:0.7,a:0.1,s:0.3,r:0.2,}],
      [{w:"triangle",v:0.3,a:0.01,d:0.7,s:0.5,},{w:"square",v:5,t:0.5,d:0.7,s:0.5,g:1,}],
      /* 89-96 : SynthPad */
      [{w:"triangle",v:0.3,a:0.02,d:0.3,s:0.3,r:0.3,},{w:"square",v:3,t:4,f:1,a:0.02,d:0.1,s:1,g:1,},{w:"triangle",v:0.08,t:0.5,a:0.1,h:0,d:0.1,s:0.5,r:0.1,b:0,c:0,}],
      [{w:"sine",v:0.3,a:0.05,d:1,s:0.7,r:0.3,},{w:"sine",v:2,f:1,d:0.3,s:1,g:1,}],
      [{w:"square",v:0.3,a:0.03,d:0.5,s:0.3,r:0.1,},{w:"square",v:4,f:1,a:0.03,d:0.1,g:1,}],
      [{w:"triangle",v:0.3,a:0.08,d:1,s:0.3,r:0.1,},{w:"square",v:2,f:1,d:0.3,s:0.3,g:1,t:4,a:0.08,}],
      [{w:"sine",v:0.3,a:0.05,d:1,s:0.3,r:0.1,},{w:"sine",v:0.1,t:2.001,f:1,d:1,s:50,g:1,}],
      [{w:"triangle",v:0.3,a:0.03,d:0.7,s:0.3,r:0.2,},{w:"sine",v:12,t:7,f:1,d:0.5,s:1.7,g:1,}],
      [{w:"sine",v:0.3,a:0.05,d:1,s:0.3,r:0.1,},{w:"sawtooth",v:22,t:6,d:0.06,s:0.3,g:1,}],
      [{w:"triangle",v:0.3,a:0.05,d:11,r:0.3,},{w:"triangle",v:1,d:1,s:8,g:1,}],
      /* 97-104 : FX */
      [{w:"sawtooth",v:0.3,d:4,s:0.8,r:0.1,},{w:"square",v:1,t:2,f:8,a:1,d:1,s:1,r:0.1,g:1,}],
      [{w:"triangle",v:0.3,d:1,s:0.5,t:0.8,a:0.2,p:1.25,q:0.2,},{w:"sawtooth",v:0.2,a:0.2,d:0.3,s:1,t:1.2,p:1.25,q:0.2,}],
      [{w:"sine",v:0.3,d:1,s:0.3,},{w:"square",v:22,t:11,d:0.5,s:0.1,g:1,}],
      [{w:"sawtooth",v:0.3,a:0.04,d:1,s:0.8,r:0.1,},{w:"square",v:1,t:0.5,d:1,s:2,g:1,}],
      [{w:"triangle",v:0.3,d:1,s:0.3,},{w:"sine",v:22,t:6,d:0.6,s:0.05,g:1,}],
      [{w:"sine",v:0.6,a:0.1,d:0.05,s:0.4,},{w:"sine",v:5,t:5,f:1,d:0.05,s:0.3,g:1,}],
      [{w:"sine",a:0.1,d:0.05,s:0.4,v:0.8,},{w:"sine",v:5,t:5,f:1,d:0.05,s:0.3,g:1,}],
      [{w:"square",v:0.3,a:0.1,d:0.1,s:0.4,},{w:"square",v:1,f:1,d:0.3,s:0.1,g:1,}],
      /* 105-112 : Ethnic */
      [{w:"sawtooth",v:0.3,d:0.5,r:0.5,},{w:"sawtooth",v:11,t:5,d:0.05,g:1,}],
      [{w:"square",v:0.3,d:0.2,r:0.2,},{w:"square",v:7,t:3,d:0.05,g:1,}],
      [{w:"triangle",d:0.2,r:0.2,},{w:"square",v:9,t:3,d:0.1,r:0.1,g:1,}],
      [{w:"triangle",d:0.3,r:0.3,},{w:"square",v:6,t:3,d:1,r:1,g:1,}],
      [{w:"triangle",v:0.4,d:0.2,r:0.2,},{w:"square",v:22,t:12,d:0.1,r:0.1,g:1,}],
      [{w:"sine",v:0.25,a:0.02,d:0.05,s:0.8,},{w:"square",v:1,t:2,d:0.03,s:11,g:1,}],
      [{w:"sine",v:0.3,a:0.05,d:11,},{w:"square",v:7,t:3,f:1,s:0.7,g:1,}],
      [{w:"square",v:0.3,a:0.05,d:0.1,s:0.8,},{w:"square",v:4,d:0.1,s:1.1,g:1,}],
      /* 113-120 : Percussive */
      [{w:"sine",v:0.4,d:0.3,r:0.3,},{w:"sine",v:7,t:9,d:0.1,r:0.1,g:1,}],
      [{w:"sine",v:0.7,d:0.1,r:0.1,},{w:"sine",v:22,t:7,d:0.05,g:1,}],
      [{w:"sine",v:0.6,d:0.15,r:0.15,},{w:"square",v:11,t:3.2,d:0.1,r:0.1,g:1,}],
      [{w:"sine",v:0.8,d:0.07,r:0.07,},{w:"square",v:11,t:7,r:0.01,g:1,}],
      [{w:"triangle",v:0.7,t:0.5,d:0.2,r:0.2,p:0.95,},{w:"n0",v:9,g:1,d:0.2,r:0.2,}],
      [{w:"sine",v:0.7,d:0.1,r:0.1,p:0.9,},{w:"square",v:14,t:2,d:0.005,r:0.005,g:1,}],
      [{w:"square",d:0.15,r:0.15,p:0.5,},{w:"square",v:4,t:5,d:0.001,r:0.001,g:1,}],
      [{w:"n1",v:0.3,a:1,s:1,d:0.15,r:0,t:0.5,}],
      /* 121-128 : SE */
      [{w:"sine",t:12.5,d:0,r:0,p:0.5,v:0.3,h:0.2,q:0.5,},{g:1,w:"sine",v:1,t:2,d:0,r:0,s:1,},{g:1,w:"n0",v:0.2,t:2,a:0.6,h:0,d:0.1,r:0.1,b:0,c:0,}],
      [{w:"n0",v:0.2,a:0.05,h:0.02,d:0.02,r:0.02,}],
      [{w:"n0",v:0.4,a:1,d:1,t:0.25,}],
      [{w:"sine",v:0.3,a:0.1,d:1,s:0.5,},{w:"sine",v:4,t:0,f:1.5,d:1,s:1,r:0.1,g:1,},{g:1,w:"sine",v:4,t:0,f:2,a:0.6,h:0,d:0.1,s:1,r:0.1,b:0,c:0,}],
      [{w:"square",v:0.3,t:0.25,d:11,s:1,},{w:"square",v:12,t:0,f:8,d:1,s:1,r:11,g:1,}],
      [{w:"n0",v:0.4,t:0.5,a:1,d:11,s:1,r:0.5,},{w:"square",v:1,t:0,f:14,d:1,s:1,r:11,g:1,}],
      [{w:"sine",t:0,f:1221,a:0.2,d:1,r:0.25,s:1,},{g:1,w:"n0",v:3,t:0.5,d:1,s:1,r:1,}],
      [{w:"sine",d:0.4,r:0.4,p:0.1,t:2.5,v:1,},{w:"n0",v:12,t:2,d:1,r:1,g:1,}],
    ],
    program0:[
// 1-8 : Piano
      [{w:"triangle",v:.5,d:.7}],                   [{w:"triangle",v:.5,d:.7}],
      [{w:"triangle",v:.5,d:.7}],                   [{w:"triangle",v:.5,d:.7}],
      [{w:"triangle",v:.5,d:.7}],                   [{w:"triangle",v:.5,d:.7}],
      [{w:"sawtooth",v:.3,d:.7}],                   [{w:"sawtooth",v:.3,d:.7}],
/* 9-16 : Chromatic Perc*/
      [{w:"sine",v:.5,d:.3,r:.3}],                  [{w:"triangle",v:.5,d:.3,r:.3}],
      [{w:"square",v:.2,d:.3,r:.3}],                [{w:"square",v:.2,d:.3,r:.3}],
      [{w:"sine",v:.5,d:.1,r:.1}],                  [{w:"sine",v:.5,d:.1,r:.1}],
      [{w:"square",v:.2,d:1,r:1}],                  [{w:"sawtooth",v:.3,d:.7,r:.7}],
/* 17-24 : Organ */
      [{w:"sine",v:0.5,a:0.01,s:1}],                [{w:"sine",v:0.7,d:0.02,s:0.7}],
      [{w:"square",v:.2,s:1}],                      [{w:"triangle",v:.5,a:.01,s:1}],
      [{w:"square",v:.2,a:.02,s:1}],                [{w:"square",v:0.2,a:0.02,s:1}],
      [{w:"square",v:0.2,a:0.02,s:1}],              [{w:"square",v:.2,a:.05,s:1}],
/* 25-32 : Guitar */
      [{w:"triangle",v:.5,d:.5}],                   [{w:"square",v:.2,d:.6}],
      [{w:"square",v:.2,d:.6}],                     [{w:"triangle",v:.8,d:.6}],
      [{w:"triangle",v:.4,d:.05}],                  [{w:"square",v:.2,d:1}],
      [{w:"square",v:.2,d:1}],                      [{w:"sine",v:.4,d:.6}],
/* 33-40 : Bass */
      [{w:"triangle",v:.7,d:.4}],                   [{w:"triangle",v:.7,d:.7}],
      [{w:"triangle",v:.7,d:.7}],                   [{w:"triangle",v:.7,d:.7}],
      [{w:"square",v:.3,d:.2}],                     [{w:"square",v:.3,d:.2}],
      [{w:"square",v:.3,d:.1,s:.2}],                [{w:"sawtooth",v:.4,d:.1,s:.2}],
/* 41-48 : Strings */
      [{w:"sawtooth",v:.2,a:.02,s:1}],              [{w:"sawtooth",v:.2,a:.02,s:1}],
      [{w:"sawtooth",v:.2,a:.02,s:1}],              [{w:"sawtooth",v:.2,a:.02,s:1}],
      [{w:"sawtooth",v:.2,a:.02,s:1}],              [{w:"sawtooth",v:.3,d:.1}],
      [{w:"sawtooth",v:.3,d:.5,r:.5}],              [{w:"triangle",v:.6,d:.1,r:.1,h:0.03,p:0.8}],
/* 49-56 : Ensamble */
      [{w:"sawtooth",v:.2,a:.02,s:1}],              [{w:"sawtooth",v:.2,a:.02,s:1}],
      [{w:"sawtooth",v:.2,a:.02,s:1}],              [{w:"sawtooth",v:.2,a:.02,s:1}],
      [{w:"triangle",v:.3,a:.03,s:1}],              [{w:"sine",v:.3,a:.03,s:1}],
      [{w:"triangle",v:.3,a:.05,s:1}],              [{w:"sawtooth",v:.5,a:.01,d:.1}],
/* 57-64 : Brass */
      [{w:"square",v:.3,a:.05,d:.2,s:.6}],          [{w:"square",v:.3,a:.05,d:.2,s:.6}],
      [{w:"square",v:.3,a:.05,d:.2,s:.6}],          [{w:"square",v:0.2,a:.05,d:0.01,s:1}],
      [{w:"square",v:.3,a:.05,s:1}],                [{w:"square",v:.3,s:.7}],
      [{w:"square",v:.3,s:.7}],                     [{w:"square",v:.3,s:.7}],
/* 65-72 : Reed */
      [{w:"square",v:.3,a:.02,d:2}],                [{w:"square",v:.3,a:.02,d:2}],
      [{w:"square",v:.3,a:.03,d:2}],                [{w:"square",v:.3,a:.04,d:2}],
      [{w:"square",v:.3,a:.02,d:2}],                [{w:"square",v:.3,a:.05,d:2}],
      [{w:"square",v:.3,a:.03,d:2}],                [{w:"square",v:.3,a:.03,d:2}],
/* 73-80 : Pipe */
      [{w:"sine",v:.7,a:.02,d:2}],                  [{w:"sine",v:.7,a:.02,d:2}],
      [{w:"sine",v:.7,a:.02,d:2}],                  [{w:"sine",v:.7,a:.02,d:2}],
      [{w:"sine",v:.7,a:.02,d:2}],                  [{w:"sine",v:.7,a:.02,d:2}],
      [{w:"sine",v:.7,a:.02,d:2}],                  [{w:"sine",v:.7,a:.02,d:2}],
/* 81-88 : SynthLead */
      [{w:"square",v:.3,s:.7}],                     [{w:"sawtooth",v:.4,s:.7}],
      [{w:"triangle",v:.5,s:.7}],                   [{w:"sawtooth",v:.4,s:.7}],
      [{w:"sawtooth",v:.4,d:12}],                   [{w:"sine",v:.4,a:.06,d:12}],
      [{w:"sawtooth",v:.4,d:12}],                   [{w:"sawtooth",v:.4,d:12}],
/* 89-96 : SynthPad */
      [{w:"sawtooth",v:.3,d:12}],                   [{w:"triangle",v:.5,d:12}],
      [{w:"square",v:.3,d:12}],                     [{w:"triangle",v:.5,a:.08,d:11}],
      [{w:"sawtooth",v:.5,a:.05,d:11}],             [{w:"sawtooth",v:.5,d:11}],
      [{w:"triangle",v:.5,d:11}],                   [{w:"triangle",v:.5,d:11}],
/* 97-104 : FX */
      [{w:"triangle",v:.5,d:11}],                   [{w:"triangle",v:.5,d:11}],
      [{w:"square",v:.3,d:11}],                     [{w:"sawtooth",v:0.5,a:0.04,d:11}],
      [{w:"sawtooth",v:.5,d:11}],                   [{w:"triangle",v:.5,a:.8,d:11}],
      [{w:"triangle",v:.5,d:11}],                   [{w:"square",v:.3,d:11}],
/* 105-112 : Ethnic */
      [{w:"sawtooth",v:.3,d:1,r:1}],                [{w:"sawtooth",v:.5,d:.3}],
      [{w:"sawtooth",v:.5,d:.3,r:.3}],              [{w:"sawtooth",v:.5,d:.3,r:.3}],
      [{w:"square",v:.3,d:.2,r:.2}],                [{w:"square",v:.3,a:.02,d:2}],
      [{w:"sawtooth",v:.2,a:.02,d:.7}],             [{w:"triangle",v:.5,d:1}],
/* 113-120 : Percussive */
      [{w:"sawtooth",v:.3,d:.3,r:.3}],              [{w:"sine",v:.8,d:.1,r:.1}],
      [{w:"square",v:.2,d:.1,r:.1,p:1.05}],         [{w:"sine",v:.8,d:.05,r:.05}],
      [{w:"triangle",v:0.5,d:0.1,r:0.1,p:0.96}],    [{w:"triangle",v:0.5,d:0.1,r:0.1,p:0.97}],
      [{w:"square",v:.3,d:.1,r:.1,}],               [{w:"n1",v:0.3,a:1,s:1,d:0.15,r:0,t:0.5,}],
/* 121-128 : SE */
      [{w:"triangle",v:0.5,d:0.03,t:0,f:1332,r:0.001,p:1.1}],
      [{w:"n0",v:0.2,t:0.1,d:0.02,a:0.05,h:0.02,r:0.02}],
      [{w:"n0",v:0.4,a:1,d:1,t:0.25,}],
      [{w:"sine",v:0.3,a:0.8,d:1,t:0,f:1832}],
      [{w:"triangle",d:0.5,t:0,f:444,s:1,}],
      [{w:"n0",v:0.4,d:1,t:0,f:22,s:1,}],
      [{w:"n0",v:0.5,a:0.2,d:11,t:0,f:44}],
      [{w:"n0",v:0.5,t:0.25,d:0.4,r:0.4}],
    ],
    drummap1:[
/*35*/  [{w:"triangle",t:0,f:70,v:1,d:0.05,h:0.03,p:0.9,q:0.1,},{w:"n0",g:1,t:6,v:17,r:0.01,h:0,p:0,}],
        [{w:"triangle",t:0,f:88,v:1,d:0.05,h:0.03,p:0.5,q:0.1,},{w:"n0",g:1,t:5,v:42,r:0.01,h:0,p:0,}],
        [{w:"n0",f:222,p:0,t:0,r:0.01,h:0,}],
        [{w:"triangle",v:0.3,f:180,d:0.05,t:0,h:0.03,p:0.9,q:0.1,},{w:"n0",v:0.6,t:0,f:70,h:0.02,r:0.01,p:0,},{g:1,w:"square",v:2,t:0,f:360,r:0.01,b:0,c:0,}],
        [{w:"square",f:1150,v:0.34,t:0,r:0.03,h:0.025,d:0.03,},{g:1,w:"n0",t:0,f:13,h:0.025,d:0.1,s:1,r:0.1,v:1,}],
/*40*/  [{w:"triangle",f:200,v:1,d:0.06,t:0,r:0.06,},{w:"n0",g:1,t:0,f:400,v:12,r:0.02,d:0.02,}],
        [{w:"triangle",f:100,v:0.9,d:0.12,h:0.02,p:0.5,t:0,r:0.12,},{g:1,w:"n0",v:5,t:0.4,h:0.015,d:0.005,r:0.005,}],
        [{w:"n1",f:390,v:0.25,r:0.01,t:0,}],
        [{w:"triangle",f:120,v:0.9,d:0.12,h:0.02,p:0.5,t:0,r:0.12,},{g:1,w:"n0",v:5,t:0.5,h:0.015,d:0.005,r:0.005,}],
        [{w:"n1",v:0.25,f:390,r:0.03,t:0,h:0.005,d:0.03,}],
/*45*/  [{w:"triangle",f:140,v:0.9,d:0.12,h:0.02,p:0.5,t:0,r:0.12,},{g:1,w:"n0",v:5,t:0.3,h:0.015,d:0.005,r:0.005,}],
        [{w:"n1",v:0.25,f:390,t:0,d:0.2,r:0.2,},{w:"n0",v:0.3,t:0,c:0,f:440,h:0.005,d:0.05,}],
        [{w:"triangle",f:155,v:0.9,d:0.12,h:0.02,p:0.5,t:0,r:0.12,},{g:1,w:"n0",v:5,t:0.3,h:0.015,d:0.005,r:0.005,}],
        [{w:"triangle",f:180,v:0.9,d:0.12,h:0.02,p:0.5,t:0,r:0.12,},{g:1,w:"n0",v:5,t:0.3,h:0.015,d:0.005,r:0.005,}],
        [{w:"n1",v:0.3,f:1200,d:0.2,r:0.2,h:0.05,t:0,},{w:"n1",t:0,v:1,d:0.1,r:0.1,p:1.2,f:440,}],
/*50*/  [{w:"triangle",f:220,v:0.9,d:0.12,h:0.02,p:0.5,t:0,r:0.12,},{g:1,w:"n0",v:5,t:0.3,h:0.015,d:0.005,r:0.005,}],
        [{w:"n1",f:500,v:0.15,d:0.4,r:0.4,h:0,t:0,},{w:"n0",v:0.1,t:0,r:0.01,f:440,}],
        [{w:"n1",v:0.3,f:800,d:0.2,r:0.2,h:0.05,t:0,},{w:"square",t:0,v:1,d:0.1,r:0.1,p:0.1,f:220,g:1,}],
        [{w:"sine",f:1651,v:0.15,d:0.2,r:0.2,h:0,t:0,},{w:"sawtooth",g:1,t:1.21,v:7.2,d:0.1,r:11,h:1,},{g:1,w:"n0",v:3.1,t:0.152,d:0.002,r:0.002,}],
        null,
/*55*/  [{w:"n1",v:.3,f:1200,d:0.2,r:0.2,h:0.05,t:0,},{w:"n1",t:0,v:1,d:0.1,r:0.1,p:1.2,f:440,}],
        null,
        [{w:"n1",v:0.3,f:555,d:0.25,r:0.25,h:0.05,t:0,},{w:"n1",t:0,v:1,d:0.1,r:0.1,f:440,a:0.005,h:0.02,}],
        [{w:"sawtooth",f:776,v:0.2,d:0.3,t:0,r:0.3,},{g:1,w:"n0",v:2,t:0,f:776,a:0.005,h:0.02,d:0.1,s:1,r:0.1,c:0,},{g:11,w:"sine",v:0.1,t:0,f:22,d:0.3,r:0.3,b:0,c:0,}],
        [{w:"n1",f:440,v:0.15,d:0.4,r:0.4,h:0,t:0,},{w:"n0",v:0.4,t:0,r:0.01,f:440,}],
/*60*/  null,null,null,null,null,
/*65*/  null,null,null,null,null,
/*70*/  null,null,null,null,null,
/*75*/  null,null,null,null,null,
/*80*/  [{w:"sine",f:1720,v:0.3,d:0.02,t:0,r:0.02,},{w:"square",g:1,t:0,f:2876,v:6,d:0.2,s:1,r:0.2,}],
        [{w:"sine",f:1720,v:0.3,d:0.25,t:0,r:0.25,},{w:"square",g:1,t:0,f:2876,v:6,d:0.2,s:1,r:0.2,}],
    ],
    drummap0:[
/*35*/[{w:"triangle",t:0,f:110,v:1,d:0.05,h:0.02,p:0.1,}],
      [{w:"triangle",t:0,f:150,v:0.8,d:0.1,p:0.1,h:0.02,r:0.01,}],
      [{w:"n0",f:392,v:0.5,d:0.01,p:0,t:0,r:0.05}],
      [{w:"n0",f:33,d:0.05,t:0,}],
      [{w:"n0",f:100,v:0.7,d:0.03,t:0,r:0.03,h:0.02,}],
/*40*/[{w:"n0",f:44,v:0.7,d:0.02,p:0.1,t:0,h:0.02,}],
      [{w:"triangle",f:240,v:0.9,d:0.1,h:0.02,p:0.1,t:0,}],
      [{w:"n0",f:440,v:0.2,r:0.01,t:0,}],
      [{w:"triangle",f:270,v:0.9,d:0.1,h:0.02,p:0.1,t:0,}],
      [{w:"n0",f:440,v:0.2,d:0.04,r:0.04,t:0,}],
/*45*/[{w:"triangle",f:300,v:0.9,d:0.1,h:0.02,p:0.1,t:0,}],
      [{w:"n0",f:440,v:0.2,d:0.1,r:0.1,h:0.02,t:0,}],
      [{w:"triangle",f:320,v:0.9,d:0.1,h:0.02,p:0.1,t:0,}],
      [{w:"triangle",f:360,v:0.9,d:0.1,h:0.02,p:0.1,t:0,}],
      [{w:"n0",f:150,v:0.2,d:0.1,r:0.1,h:0.05,t:0,p:0.1,}],
/*50*/[{w:"triangle",f:400,v:0.9,d:0.1,h:0.02,p:0.1,t:0,}],
      [{w:"n0",f:150,v:0.2,d:0.1,r:0.01,h:0.05,t:0,p:0.1}],
      [{w:"n0",f:150,v:0.2,d:0.1,r:0.01,h:0.05,t:0,p:0.1}],
      [{w:"n0",f:440,v:0.3,d:0.1,p:0.9,t:0,r:0.1,}],
      [{w:"n0",f:200,v:0.2,d:0.05,p:0.9,t:0,}],
/*55*/[{w:"n0",f:440,v:0.3,d:0.12,p:0.9,t:0,}],
      [{w:"sine",f:800,v:0.4,d:0.06,t:0,}],
      [{w:"n0",f:150,v:0.2,d:0.1,r:0.01,h:0.05,t:0,p:0.1}],
      [{w:"n0",f:33,v:0.3,d:0.2,p:0.9,t:0,}],
      [{w:"n0",f:300,v:0.3,d:0.14,p:0.9,t:0,}],
/*60*/[{w:"sine",f:200,d:0.06,t:0,}],
      [{w:"sine",f:150,d:0.06,t:0,}],
      [{w:"sine",f:300,t:0,}],
      [{w:"sine",f:300,d:0.06,t:0,}],
      [{w:"sine",f:250,d:0.06,t:0,}],
/*65*/[{w:"square",f:300,v:.3,d:.06,p:.8,t:0,}],
      [{w:"square",f:260,v:.3,d:.06,p:.8,t:0,}],
      [{w:"sine",f:850,v:.5,d:.07,t:0,}],
      [{w:"sine",f:790,v:.5,d:.07,t:0,}],
      [{w:"n0",f:440,v:0.3,a:0.05,t:0,}],
/*70*/[{w:"n0",f:440,v:0.3,a:0.05,t:0,}],
      [{w:"triangle",f:1800,v:0.4,p:0.9,t:0,h:0.03,}],
      [{w:"triangle",f:1800,v:0.3,p:0.9,t:0,h:0.13,}],
      [{w:"n0",f:330,v:0.3,a:0.02,t:0,r:0.01,}],
      [{w:"n0",f:330,v:0.3,a:0.02,t:0,h:0.04,r:0.01,}],
/*75*/[{w:"n0",f:440,v:0.3,t:0,}],
      [{w:"sine",f:800,t:0,}],
      [{w:"sine",f:700,t:0,}],
      [{w:"n0",f:330,v:0.3,t:0,}],
      [{w:"n0",f:330,v:0.3,t:0,h:0.1,r:0.01,p:0.7,}],
/*80*/[{w:"sine",t:0,f:1200,v:0.3,r:0.01,}],
      [{w:"sine",t:0,f:1200,v:0.3,d:0.2,r:0.2,}],

    ],
    /* The waveform registry (#26): name -> the caller's data, copied as Float32Arrays ([real, imag]
       for a w* wave, [samples] for an n* wave). It outlives contexts; _mk builds each wave's
       PeriodicWave or AudioBuffer into wave/noiseBuf for the installed context. */
    _wv:new Map(),
    ready:()=>{
      /* The synth is ready when the constructor returns; kept for compatibility. */
      return Promise.resolve();
    },
    init:(ctx,dest)=>{
      if(this._tid) // the constructor's step: once only, so no second interval or context
        return;
      this.pg=[]; this.vol=[]; this.ex=[]; this.bend=[]; this.rpnidx=[]; this.brange=[];
      this.sustain=[]; this.notetab=[]; this.rhythm=[];
      this.masterTuningC=0; this.masterTuningF=0; this.tuningC=[]; this.tuningF=[]; this.scaleTuning=[];
      this.maxTick=0, this.playTick=0, this.playing=0; this.releaseRatio=3.5;
      for(let i=0;i<16;++i){
        this.pg[i]=0; this.vol[i]=3*100*100/(127*127);
        this.bend[i]=0; this.brange[i]=0x100;
        this.tuningC[i]=0; this.tuningF[i]=0;
        this.scaleTuning[i]=[0,0,0,0,0,0,0,0,0,0,0,0];
        this.rhythm[i]=0;
      }
      this.rhythm[9]=1;
      this.preroll=0.2;
      this.relcnt=0;
      /* Lifecycle (#11, #12): the installed context, whether the synth created it (_own), the
         one-shot sources (percussion hits and playMIDI's start-up oscillator, kept until they
         end), the voices stopped but not yet ended (_gone), and pending work that dispose()
         cancels: functions it calls once (a hook for URL loads, T5). */
      this.actx=this.audioContext=null;
      this.chvol=[]; this.chmod=[]; this.chpan=[];
      this._own=0;
      this._src=[];
      this._p=[]; this._m=[]; // the latest pan and modulation values set, per channel
      this._gone=new Set();
      this._pend=new Set();
      this._tid=setInterval(
        function(){
          const c=this.actx;
          /* Nothing to do without a realtime context: a lazy synth before first use, a disposed
             one, or an OfflineAudioContext, whose notes end at their own times (#12). */
          if(!c || this._off)
            return;
          if(++this.relcnt>=3){
            this.relcnt=0;
            for(let i=this.notetab.length-1;i>=0;--i){
              var nt=this.notetab[i];
              if(this.actx.currentTime>nt.e){
                this._pruneNote(nt);
                this.notetab.splice(i,1);
              }
            }
            this._src=this._src.filter(v=>v.e>=c.currentTime);
          }
          /* playMIDI only starts songs with events. At most 1000 events per callback
             (#8): the rest follow on the next callbacks, in order, at their own times. */
          if(this.playing){
            let e=this.song.ev[this.playIndex],n=1e3;
            while(n-- && this.actx.currentTime+this.preroll>this.playTime){
              if(e.m[0]==0xff51){
                this.song.tempo=e.m[1];
                this.tick2Time=4*60/this.song.tempo/this.song.timebase;
              }
              else
                this.send(e.m,this.playTime);
              ++this.playIndex;
              if(this.playIndex>=this.song.ev.length){
                /* Wrap only if the next pass advances (#8). Without a positive loopEnd,
                   a song whose events share one tick would repeat at one instant
                   forever, so it ends here as if looping were off. */
                if(this.loop && (this.loopEnd>0 || this.playTick>this.song.ev[0].t)){
                  e=this.song.ev[this.playIndex=0];
                  if(this.loopEnd){
                    /* Pad to loopEnd at the tempo the pass ended on. Then restart at
                       the song's starting tempo: 120 BPM, the MIDI default that
                       loadMIDI starts from (a tempo event at tick 0 re-applies at
                       once). Time the leading rest before ev[0] at that tempo. */
                    this.playTime+=(Math.max(this.loopEnd,this.playTick)-this.playTick)*this.tick2Time;
                    this.song.tempo=120;
                    this.tick2Time=4*60/this.song.tempo/this.song.timebase;
                    this.playTime+=e.t*this.tick2Time;
                  }
                  /* The new pass stands at its tick 0 (see playMIDI), which sounds e.t ticks
                     before ev[0]: at the padded end with loopEnd, else virtually (D-023). _x0:
                     the pass's opening seconds per tick (inherited without loopEnd). */
                  this._z=1;
                  this._st=this.playTime-e.t*(this._x0=this.tick2Time);
                  this.playTick=e.t;
                }
                else{
                  this.playTick=this.maxTick;
                  this.playing=0;
                  break;
                }
              }
              else{
                e=this.song.ev[this.playIndex];
                this.playTime+=(e.t-this.playTick)*this.tick2Time;
                this.playTick=e.t;
              }
            }
          }
        }.bind(this),60
      );
      if(this.debug)
        console.log("internalcontext:"+this.internalcontext)
      if(ctx)
        this.setAudioContext(ctx,dest);
      else if(this.internalcontext && !this._lazy)
        this._create();
      this.isReady=1;
    },
    _create:()=>{
      /* Create and install the synth-owned context. If installing it fails (a registered wave the
         context refuses, #26, or any later step), the new context is closed and whatever part of
         its graph was installed is torn down and released (_drop), so the synth is left without a
         context, nothing stays open or referenced, and the error propagates; the next use retries. */
      window.AudioContext = window.AudioContext || window.webkitAudioContext;
      const c=new AudioContext();
      try{
        this.setAudioContext(c);
      }catch(e){
        this.actx==c ? this._drop(1) : c.close().catch(()=>{});
        throw e;
      }
      this._own=1;
      return this.actx;
    },
    _live:()=>{
      /* The guard at the top of each method that makes sound or sets channel or song state
         (send, noteOn, setProgram, setBendRange, setBend, setSustain, setModulation,
         setChVol, setPan, setExpression, loadMIDI, locateMIDI, playMIDI): false once disposed,
         so the method does nothing; otherwise there is a context, created now if the synth is
         lazy (before any state is set that installing the graph would reset). */
      return !this._dead && !!(this.actx || this._lazy && this._create());
    },
    _wake:()=>{
      /* send()'s resume: at most one context.resume() per context and task, so a seek that
         replays many events asks once (T3 review F9), and a context installed in the same
         task is still asked. Its rejection is handled, and an OfflineAudioContext (resume()
         rejects before rendering) or a closed context is never asked. */
      const c=this.actx,s=c&&c.state;
      if(this._rq!=c && !this._off && (s=="suspended" || s=="interrupted")){
        this._rq=c;
        Promise.resolve().then(()=>{ this._rq=0; });
        Promise.resolve(c.resume()).catch(()=>{});
      }
    },
    resume:()=>{
      /* Resolves once the context runs: creates a lazy context, and calls context.resume()
         at once, so it works inside a click, key or pointer handler. Rejects with the
         context's error, or with an Error whose message and code are AUDIO_CONTEXT_CLOSED or
         SYNTH_DISPOSED. Resolves without action on an OfflineAudioContext. */
      return new Promise((resolv,reject)=>{
        if(this._dead)
          throw CodedError("SYNTH_DISPOSED");
        const c=this.actx || this._create();
        if(c.state=="closed")
          throw CodedError("AUDIO_CONTEXT_CLOSED");
        if(this._off || c.state=="running")
          return resolv();
        c.resume().then(resolv,reject);
      });
    },
    dispose:()=>{
      /* Idempotent and terminal; returns the same promise on every call. Clears the timer,
         cancels pending work, stops every owned source, disconnects every owned node and
         releases them. Closes the context only if the synth created it, and resolves after
         that close. Afterwards the guarded methods do nothing (see the constructor). */
      if(!this._dp){
        this._dead=1;
        clearInterval(this._tid);
        this.playing=0;
        this._pend.forEach(f=>{
          try{ f(); }catch(e){ /* a canceller must not stop the disposal */ }
        });
        this._pend.clear();
        this.song=null;
        this._dp=this._drop(this._own);
      }
      return this._dp;
    },
    _check:(c,d)=>{
      if(!c || typeof c.createGain!="function" || !c.destination)
        throw new TypeError("context");
      if(d!=undefined && (typeof d.connect!="function" || d.context && d.context!=c))
        throw new TypeError("destination");
    },
    _drop:(close)=>{
      /* Tear down the installed graph (#11): stop every voice and one-shot source, replace
         their callbacks, disconnect them and every graph node, and release them. Returns a
         promise that settles after the context is closed, when `close` is set. On a realtime
         context that stays open, a source and its gain are disconnected when the source ends
         (Chromium can keep an oscillator disconnected right after stop() from ever ending); a
         closed or offline one dispatches no more ended events, so it is done at once. A graph
         that failed part-way through installation (see _create) has no LFO yet. */
      const c=this.actx,n=x=>x && x.disconnect(),now=close || this._off || c && c.state=="closed";
      if(c){
        this.notetab.concat(this._src,Array.from(this._gone),this.lfo ? {o:[this.lfo],g:[]} : []).forEach(v=>{
          v.o.forEach((s,i)=>{
            const off=()=>{ n(s); n(v.g[i]); n(v.q && v.q[i]); }; // and the operator's filter (#27)
            s.onended=now ? null : off;
            try{ s.stop(); }catch(e){ /* stop() again: some engines throw */ }
            if(now)
              off();
          });
        });
        [this.out,this.comp,this.conv,this.rev].concat(this.chvol,this.chmod,this.chpan).forEach(n);
        this.notetab=[]; this._src=[]; this._gone.clear(); this.chvol=[]; this.chmod=[]; this.chpan=[];
        this.actx=this.audioContext=this.dest=this.out=this.comp=this.conv=this.rev=this.lfo=this.wave=this.noiseBuf=this.convBuf=null;
      }
      return new Promise(r=>r(c && close && c.state!="closed" && c.close())).then(()=>{},()=>{});
    },
    setMasterVol:(v)=>{
      if(v!=undefined)
        this.masterVol=v;
      if(this.out)
        this.out.gain.value=this.masterVol;
    },
    setReverbLev:(v)=>{
      if(v!=undefined)
        this.reverbLev=v;
      var r=parseFloat(this.reverbLev);
      if(this.rev&&!isNaN(r))
        this.rev.gain.value=r*8;
    },
    setLoop:(f)=>{
      this.loop=f;
    },
    setLoopEnd:(t)=>{
      this.loopEnd=t;
    },
    setVoices:(v)=>{
      this.voices=v;
    },
    getPlayStatus:()=>{
      /* startTime (D-023): the AudioContext time at which tick 0 of the current pass sounds
         (see playMIDI), or null when not playing. Like curTick, it follows the scheduler: it
         moves to the next pass once the current pass's last event is scheduled, up to 0.2 s
         before that event sounds and before any rest up to loopEnd, so it can be later than
         currentTime. */
      return {play:this.playing, maxTick:this.maxTick, curTick:this.playTick, startTime:this.playing?this._st:null};
    },
    locateMIDI:(tick,load)=>{
      if(!this._live())
        return;
      /* Seek (#21, D-005): stop all notes, restore the state loadMIDI installs (reset(),
         scale tuning 0, 120 BPM), then apply the tempo and channel-state events before
         tick, in order, through send() and without notes. Playback resumes at the first
         event at or after tick; with none left, curTick is maxTick and play restarts.
         Without a song this does nothing. Queued channel volume, pan and modulation
         changes (from the scheduler's lookahead or a timed send()) are cancelled first, by
         stopMIDI(), so they cannot override the rebuilt state. loadMIDI passes load, which
         stops as upstream instead and keeps the upstream load calls (D-019, D-023). */
      const s=this.song,p=this.playing;
      let i,e;
      if(!s)
        return;
      load ? this._halt() : this.stopMIDI();
      this.reset();
      for(i=0;i<16;)
        this.scaleTuning[i++].fill(0);
      for(s.tempo=120,i=0;(e=s.ev[i]) && e.t<tick;++i){
        if(e.m[0]==0xff51)
          s.tempo=e.m[1];
        else if((e.m[0]&0xe0)!=0x80) // not a note-off or note-on
          this.send(e.m);
      }
      this.playIndex=i; // ev.length when no event is left: playMIDI restarts the song
      this.playTick=e?e.t:this.maxTick;
      this._z=!(tick>0); // at tick 0, not a seek into the leading rest (playMIDI, D-023)
      this._x0=0; // the song's own opening tempo, 120 BPM (playMIDI)
      if(p)
        this.playMIDI();
    },
    getTimbreName:(m,n)=>{
      if(m==0)
        return this.program[n].name;
      else
        return this.drummap[n-35].name;
    },
    loadMIDIfromSrc:()=>{
      this.loadMIDIUrl(this.src);
    },
    loadMIDIUrl:(url)=>{
      if(!url)
        return;
      var xhr=new XMLHttpRequest();
      xhr.open("GET",url,true);
      xhr.responseType="arraybuffer";
      xhr.loadMIDI=this.loadMIDI.bind(this);
      xhr.onload=function(){
        if(this.status==200){
          this.loadMIDI(this.response);
        }
      };
      xhr.send();
    },
    reset:()=>{
      for(let i=0;i<16;++i){
        this.setProgram(i,0);
        this.setBendRange(i,0x100);
        this.setModulation(i,0);
        this.setChVol(i,100);
        this.setPan(i,64);
        this.resetAllControllers(i);
        this.allSoundOff(i);
        this.rhythm[i]=0;
        this.tuningC[i]=0;
        this.tuningF[i]=0;
      }
      this.masterTuningC=0;
      this.masterTuningF=0;
      this.rhythm[9]=1;
    },
    _halt:()=>{
      /* The upstream stop, kept for loadMIDI's internal stops (D-023). A load sets every
         channel again, so nothing is left to apply on the next playMIDI(). */
      this.playing=this._rs=0;
      for(var i=0;i<16;++i)
        this.allSoundOff(i);
    },
    stopMIDI:()=>{
      /* A caller's stop silences everything the transport scheduled (D-023, #11): melodic
         voices, as upstream; every percussion hit, sounding or scheduled ahead (D-019); and
         the queued channel volume, pan and modulation automation, cancelled from now on, so
         nothing changes after the stop. The next playMIDI() first applies each channel's
         latest volume, expression, pan and modulation (_rs), the state at the resume position,
         since the cancelled changes the song had sent ahead are not sent again (review F1).
         A seek stops the same way. Nodes a caller swapped into chvol are handled (not a
         supported API). */
      const c=this.actx;
      let i,v;
      this._halt();
      if(c){
        for(i=this._src.length-1;i>=0;--i){
          if((v=this._src[i]).ch!=undefined){
            this._src.splice(i,1);
            if(v.e>c.currentTime) // a hit that has ended needs nothing
              this._pruneNote(v);
          }
        }
        for(i=0;i<16;++i)
          [(this.chvol[i]||0).gain,(this.chmod[i]||0).gain,(this.chpan[i]||0).pan].forEach(a=>a && a.cancelScheduledValues(c.currentTime));
        this._rs=1;
      }
    },
    playMIDI:()=>{
      if(!this._live())
        return;
      /* A song with no events other than tempo (empty, metadata-only or tempo-only)
         stays stopped (#9). A completed song (not one just loaded at maxTick) starts a
         new pass with the state of locateMIDI(0) (#10, D-005), but the previous pass's
         sounding and already scheduled notes play on, as upstream (D-019): its voices are
         kept out of the seek's reach. A song stopped before its end resumes as it is. */
      const s=this.song,n=this.notetab,d=this._src;
      /* The sequencer runs on the realtime timer, which cannot follow an offline render's
         clock (#12, tasks/T4.md): schedule notes with explicit times instead. */
      if(this._off)
        throw CodedError("AUDIO_CONTEXT_OFFLINE");
      if(!s || !s.ev.some(e=>e.m[0]!=0xff51))
        return;
      if(this.playIndex && this.playTick>=this.maxTick)
        this.notetab=[], this._src=[], this.playing=0, this.locateMIDI(0), this.notetab=n, this._src=d;
      if(this._rs) // after a caller's stop: the channels' latest values, now (review F1)
        for(let i=this._rs=0;i<16;++i)
          [[this.chvol[i],"gain",this.vol[i]*this.ex[i]],[this.chmod[i],"gain",this._m[i]],[this.chpan[i],"pan",this._p[i]]].forEach(([n,k,x])=>n && n[k].setValueAtTime(x||0,this.actx.currentTime));
      const dummy=this.actx.createOscillator();
      dummy.connect(this.actx.destination);
      dummy.frequency.value=0;
      dummy.start(0);
      dummy.stop(this.actx.currentTime+0.001);
      dummy.onended=()=>dummy.disconnect();
      this._src.push({o:[dummy],g:[],e:this.actx.currentTime+0.001});
      /* Start timing (#21, D-023). t: seconds from tick 0 to the next event (playTick) under
         the pass's tempo map: the song's, from 120 BPM until its first tempo event, except
         that a pass the default loop started opens at the tempo it inherited (_x0, set at
         the wrap and cleared by locateMIDI), as it plays. With a positive loopEnd, a
         pass that stands at tick 0 with nothing of it played yet (after loadMIDI(),
         locateMIDI(0), a completed song, a loop, or a stop before its first event) keeps its
         leading rest, as later passes do: tick 0 sounds 0.1 s from now. Otherwise the next
         event plays 0.1 s from now, as upstream and after a seek (next-event positioning,
         D-005), and startTime (_st) is when tick 0 would have sounded, now + 0.1 s - t. */
      let t=0,k=0,x=this._x0||2/s.timebase,a=this.actx.currentTime+.1;
      for(const e of s.ev.slice(0,this.playIndex+1)){
        t+=(e.t-k)*x;
        k=e.t;
        if(e.m[0]==0xff51)
          x=240/e.m[1]/s.timebase;
      }
      if(this.loopEnd>0 && this._z && !this.playIndex)
        this.playTime=(this._st=a)+t;
      else
        this._st=(this.playTime=a)-t;
      this.tick2Time=4*60/s.tempo/s.timebase;
      this.playing=1;
    },
    loadMIDI:(data)=>{
      if(!this._live())
        return;
      /* Parse a Standard MIDI File (format 0 or 1, ticks-per-quarter-note division)
         into a new song, then install it. Each chunk read must lie inside the file,
         and every read is bounded by its chunk. On failure this throws an Error whose
         code is SMF_INVALID_HEADER, SMF_UNSUPPORTED_FORMAT, SMF_UNSUPPORTED_DIVISION,
         SMF_TRUNCATED or SMF_MALFORMED, with offset (absolute byte offset) and, from
         the first track chunk on, track (0-based MTrk index). Nothing is changed by
         a failed load: the previous song, playback and channel state remain. Running
         status is per track and is cancelled by meta and SysEx events. Unknown chunks
         are skipped. A track without End-of-Track is accepted when its chunk ends
         right after a complete event and is followed by the end of the file or by
         an MTrk chunk; the track then ends at that event's tick. */
      var s=new Uint8Array(data), n=s.length, song={copyright:"",text:"",tempo:120,timebase:0,ev:[]};
      var TRUNCATED="SMF_TRUNCATED", MALFORMED="SMF_MALFORMED", maxTick=0, tr=-1, ntrk, len, idx, end, p, e0, tick, rs, v, k, m;
      function Fail(code, msg, off) {
        var e=new Error(code+": "+msg+" ("+(tr<0?"":"track "+tr+", ")+"byte "+off+")");
        e.code=code;
        e.offset=off;
        if(tr>=0)
          e.track=tr;
        throw e;
      }
      function Need(k, what, at) {
        if(p+k>end)
          Fail(TRUNCATED,what+" past chunk end",at);
      }
      function Get2(i) { return (s[i]<<8) + s[i+1]; }
      function Get4(i) { return s[i]*0x1000000 + (s[i+1]<<16) + (s[i+2]<<8) + s[i+3]; }
      function GetStr(i, len) {
        for(var r="",k;len>0;i+=k,len-=k)
          r+=String.fromCharCode.apply(null,s.subarray(i,i+(k=len<8192?len:8192)));
        return r;
      }
      function Vlq() {
        for(var v=0,k=0,d,at=p;;){
          Need(1,"VLQ",at);
          v=v*128+((d=s[p++])&0x7f);
          if(d<0x80)
            return v;
          if(++k>3)
            Fail(MALFORMED,"VLQ over 4 bytes",at);
        }
      }
      if(Get4(0)!=0x4d546864) // "MThd"; NaN when the file is shorter than 4 bytes
        Fail("SMF_INVALID_HEADER","no MThd header",0);
      if(n>=8 && (len=Get4(4))<6)
        Fail("SMF_INVALID_HEADER","header length "+len+" under 6",4);
      if(n<8 || n<8+len)
        Fail(TRUNCATED,"header past file end",0);
      if((v=Get2(8))>1)
        Fail("SMF_UNSUPPORTED_FORMAT","format "+v,8);
      if((v=Get2(12))&0x8000 || !v)
        Fail("SMF_UNSUPPORTED_DIVISION",(v?"SMPTE ":"")+"division 0x"+v.toString(16),12);
      song.timebase=v*4;
      ntrk=Get2(10);
      for(idx=8+len,tr=0;tr<ntrk;idx=end){
        if(idx+8>n)
          Fail(TRUNCATED,"no track "+tr+" of "+ntrk,idx);
        if((end=idx+8+Get4(idx+4))>n)
          Fail(TRUNCATED,"chunk past file end",idx);
        if(Get4(idx)!=0x4d54726b) // not "MTrk"
          continue;
        for(p=idx+8,tick=0,rs=0;;){
          if(p>=end){ // no End-of-Track: accepted only at the end of the file or before a track chunk
            if(end<n && Get4(end)!=0x4d54726b)
              Fail(MALFORMED,"no End-of-Track",end);
            break;
          }
          tick+=Vlq();
          Need(1,"event",e0=p);
          if((v=s[p])<0x80){
            if(!rs)
              Fail(MALFORMED,"no running status",e0);
            v=rs;
          }
          else
            ++p;
          if(v<0xf0){
            Need(k=(v&0xe0)==0xc0?1:2,"channel message",e0);
            for(m=k>1?[rs=v,s[p],s[p+1]]:[rs=v,s[p]];k--;)
              if(s[p++]>0x7f)
                Fail(MALFORMED,"bad data byte",p-1);
            song.ev.push({t:tick,m:m});
          }
          else if(v==0xf0 || v==0xf7){
            rs=0;
            Need(len=Vlq(),"SysEx event",e0);
            m=Array.from(s.subarray(p,p+len));
            m.unshift(0xf0);
            song.ev.push({t:tick,m:m});
            p+=len;
          }
          else if(v==0xff){
            rs=0;
            Need(1,"meta event",e0);
            k=s[p++];
            Need(len=Vlq(),"meta event",e0);
            if(k==0x2f){
              if(len)
                Fail(MALFORMED,"End-of-Track length "+len,e0);
              break;
            }
            if(k==0x51){
              if(len!=3 || !(v=(s[p]<<16) + (s[p+1]<<8) + s[p+2]))
                Fail(MALFORMED,"bad tempo",e0);
              song.ev.push({t:tick, m:[0xff51, 60000000 / v]});
            }
            else if(k==0x02)
              song.copyright+=GetStr(p, len);
            else if(k==0x01 || k==0x03 || k==0x04 || k==0x09)
              song.text=GetStr(p, len);
            p+=len;
          }
          else
            Fail(MALFORMED,"bad status 0x"+v.toString(16),e0);
        }
        if(tick>maxTick)
          maxTick=tick;
        ++tr;
      }
      song.ev.sort(function(x,y){return x.t-y.t});
      this._halt(); // internal: the upstream calls (D-023)
      if(tr)
        this.notetab.length=0;
      this.maxTick=maxTick;
      this.song=song;
      this.locateMIDI(0,1); // includes reset()
    },
    setQuality:(q)=>{
      if(q!=undefined)
        this.quality=q;
      for(let i=0;i<128;++i)
        this.setTimbre(0,i,this.program0[i]);
      for(let i=0;i<this.drummap0.length;++i)
        this.setTimbre(1,i+35,this.drummap0[i]);
      if(this.quality){
        for(let i=0;i<this.program1.length;++i)
          this.setTimbre(0,i,this.program1[i]);
        for(let i=0;i<this.drummap.length;++i){
          if(this.drummap1[i])
            this.setTimbre(1,i+35,this.drummap1[i]);
        }
      }
    },
    _checkFilter:(o)=>{
      /* setTimbre's filter check (#27, D-007 and D-028) for operator o: throws a TypeError or
         RangeError, and changes nothing. Without fl, none of ff, fq and fk is given. With fl
         ("lowpass", "highpass" or "bandpass"), o outputs audio (g absent or 0), ff is a number,
         fq is absent or a number, both normal positive 32-bit floats (the AudioParam type:
         from 2^-126; a smaller low- or high-pass fq gives NaN coefficients, and a smaller ff a
         0 Hz or subnormal cutoff), and fk is absent, 0 or 1. Undefined counts as absent. */
      const u=k=>o[k]===undefined,c=(k,ok)=>{
        if(typeof o[k]!="number")
          throw new TypeError(k+": "+String(o[k]));
        if(!ok)
          throw new RangeError(k+": "+o[k]);
      };
      if(u("fl")){
        for(const k of ["ff","fq","fk"])
          if(!u(k))
            throw new TypeError(k+" without fl");
        return;
      }
      if(!["lowpass","highpass","bandpass"].includes(o.fl))
        throw new TypeError("fl: "+String(o.fl));
      if(!u("g") && o.g!=0)
        throw new TypeError("fl on a modulator");
      for(const k of ["ff","fq"])
        if(k=="ff" || !u(k))
          c(k,o[k]>=2**-126 && isFinite(Math.fround(o[k])));
      if(!u("fk"))
        c("fk",o.fk==0 || o.fk==1);
    },
    setTimbre:(m,n,p)=>{
      for(let i=0;i<p.length;) this._checkFilter(p[i++]); // filter fields (#27), before any change
      const defp={g:0,w:"sine",t:1,f:0,v:0.5,a:0,h:0.01,d:0.01,s:0,r:0.05,p:1,q:1,k:0};
      function filldef(p){
        for(n=0;n<p.length;++n){
          for(let k in defp){
            // eslint-disable-next-line no-prototype-builtins -- legacy timbre filling; validation is reworked in #13
            if(!p[n].hasOwnProperty(k) || typeof(p[n][k])=="undefined")
              p[n][k]=defp[k];
          }
        }
        return p;
      }
      for(let i=0;i<p.length;++i) // every wave is known before anything changes (#26)
        this._checkWave(p[i].w);
      if(m && n>=35 && n<=81)
        this.drummap[n-35].p=filldef(p);
      if(m==0 && n>=0 && n<=127)
        this.program[n].p=filldef(p);
    },
    _checkWave:(w)=>{
      /* setTimbre's wave check (#26, D-006): an operator's w is undefined (the default, sine), a
         built-in or a registered name. Anything else throws a TypeError; nothing else happens.
         Unsupported compatibility path: a name a caller wrote into noiseBuf (n*) or wave (w*)
         itself, as TinyChip does, is accepted too; _note plays it as before (440 basis). */
      const o=typeof w=="string" && (w[0]=="n" ? this.noiseBuf : w[0]=="w" && this.wave);
      if(w!==undefined && !"sine square sawtooth triangle w9999 n0 n1".split(" ").includes(w) && !this._wv.has(w) && !(o && {}.hasOwnProperty.call(o,w)))
        throw new TypeError("unknown wave: "+w);
    },
    _pruneNote:(nt)=>{
      for(let k=nt.o.length-1;k>=0;--k){
        if(nt.o[k].frequency){
          nt.o[k].frequency.cancelScheduledValues(0);
        }
        else{
          nt.o[k].playbackRate.cancelScheduledValues(0);
        }
        nt.g[k].gain.cancelScheduledValues(0);

        try {
          nt.o[k].stop();
        } catch (e) { /* a percussion hit is already stopped: some engines throw */ }
        if(nt.o[k].detune) {
          try {
            this.chmod[nt.ch].disconnect(nt.o[k].detune);
          } catch (e) { /* the detune input is not connected: nothing to disconnect */ }
        }
        nt.g[k].gain.value = 0;
        /* Release the voice's routes once it has ended (#11). Disconnecting earlier can keep
           Chromium from ever ending (and releasing) a stopped oscillator. Until all its
           sources have ended the voice stays in _gone, so a teardown still reaches it. */
        const o=nt.o[k],g=nt.g[k],b=nt.q[k]; // b: the operator's filter, if any (#27)
        o.onended=()=>{ o.disconnect(); g.disconnect(); b && b.disconnect(); --nt.l || this._gone.delete(nt); };
      }
      nt.l=nt.o.length;
      this._gone.add(nt);
    },
    _limitVoices:(ch,n)=>{ // eslint-disable-line no-unused-vars -- callers pass the new note; the limit is global
      this.notetab.sort(function(n1,n2){
        if(n1.f!=n2.f) return n1.f-n2.f;
        if(n1.e!=n2.e) return n2.e-n1.e;
        return n2.t-n1.t;
      });
      for(let i=this.notetab.length-1;i>=0;--i){
        var nt=this.notetab[i];
        if(this.actx.currentTime>nt.e || i>=(this.voices-1)){
          this._pruneNote(nt);
          this.notetab.splice(i,1);
        }
      }
    },
    _filter:(pn,f,out)=>{
      /* An audio-output operator's fixed filter (#27, D-007 and D-028), connected to out and
         returned. Type fl. Cutoff or centre: ff Hz, or with fk 1 ff times the note-on frequency
         f (master, channel and scale tuning included; operator ratio and offset, bend, pitch
         envelope and modulation excluded), clamped to 0.45 x the sample rate (tasks/T12.md).
         fq (default Math.SQRT1_2) is a linear Q, given in dB to low- and high-pass. */
      const b=this.actx.createBiquadFilter(),q=pn.fq||Math.SQRT1_2;
      b.type=pn.fl;
      b.frequency.value=Math.min(pn.fk ? f*pn.ff : pn.ff,this.actx.sampleRate*.45);
      b.Q.value=pn.fl=="bandpass" ? q : 20*Math.log10(q);
      b.connect(out);
      return b;
    },
    _note:(t,ch,n,v,p)=>{
      let out,sc,pn;
      const o=[],g=[],vp=[],fp=[],r=[],b=[],l=[];
      const f=440*Math.pow(2,(n-69 + this.masterTuningC + this.tuningC[ch] + (this.masterTuningF + this.tuningF[ch]/8192 + this.scaleTuning[ch][n%12]))/12);
      /* Every operator's wave is resolved first (#26): when one is missing from this context (a
         timbre written past setTimbre), the note is dropped before a voice is stolen or a node made.
         A buffer plays at fp/b[i]: the home pitch _mk tagged a registered wave's buffer with (D-027),
         looping its N*k frames (l[i] seconds, before the guard frame); else 440 (n0, n1, buffers a
         caller wrote, even over a registered name). Only n* and w* names are looked up, and no
         Object.prototype key starts so. */
      for(let i=0;i<p.length;++i){
        const w=p[i].w,x=w[0]=="n" && this.noiseBuf[w];
        if(w[0]=="n" ? !x : w[0]=="w" && !this.wave[w])
          return;
        l[i]=x && x._l;
        b[i]=x && x._b || 440;
      }
      this._limitVoices(ch,n);
      const q=[]; // the output operators' filters, by operator (#27)
      for(let i=0;i<p.length;++i){
        pn=p[i];
        const dt=t+pn.a+pn.h;
        if(pn.g==0)
          out=this.chvol[ch], sc=v*v/16384, fp[i]=f*pn.t+pn.f;
        else if(pn.g>10)
          out=g[pn.g-11].gain, sc=1, fp[i]=fp[pn.g-11]*pn.t+pn.f;
        else if(o[pn.g-1].frequency)
          out=o[pn.g-1].frequency, sc=fp[pn.g-1], fp[i]=fp[pn.g-1]*pn.t+pn.f;
        else
          out=o[pn.g-1].playbackRate, sc=fp[pn.g-1]/b[pn.g-1], fp[i]=fp[pn.g-1]*pn.t+pn.f;
        switch(pn.w[0]){
        case "n":
          o[i]=this.actx.createBufferSource();
          o[i].buffer=this.noiseBuf[pn.w];
          o[i].loop=true;
          if(l[i])
            o[i].loopEnd=l[i];
          o[i].playbackRate.value=fp[i]/b[i];
          if(pn.p!=1)
            this._setParamTarget(o[i].playbackRate,fp[i]/b[i]*pn.p,t,pn.q);
          if (o[i].detune) {
            this.chmod[ch].connect(o[i].detune);
            o[i].detune.value=this.bend[ch];
          }
          break;
        default:
          o[i]=this.actx.createOscillator();
          o[i].frequency.value=fp[i];
          if(pn.p!=1)
            this._setParamTarget(o[i].frequency,fp[i]*pn.p,t,pn.q);
          if(pn.w[0]=="w")
            o[i].setPeriodicWave(this.wave[pn.w]);
          else
            o[i].type=pn.w;
          if (o[i].detune) {
            this.chmod[ch].connect(o[i].detune);
            o[i].detune.value=this.bend[ch];
          }
          break;
        }
        g[i]=this.actx.createGain();
        r[i]=pn.r;
        o[i].connect(g[i]); g[i].connect(pn.g==0 && pn.fl ? (q[i]=this._filter(pn,f,out)) : out);
        vp[i]=sc*pn.v;
        if(pn.k)
          vp[i]*=Math.pow(2,(n-60)/12*pn.k);
        if(pn.a){
          g[i].gain.value=0;
          g[i].gain.setValueAtTime(0,t);
          g[i].gain.linearRampToValueAtTime(vp[i],t+pn.a);
        }
        else
          g[i].gain.setValueAtTime(vp[i],t);
        this._setParamTarget(g[i].gain,pn.s*vp[i],dt,pn.d);
        o[i].start(t);
        if(this.rhythm[ch]){

          o[i].onended = ()=>{
            o[i].disconnect(); g[i].disconnect(); q[i] && q[i].disconnect(); // release the hit's routes (#11, #27)
            try {
              if (o[i].detune) this.chmod[ch].disconnect(o[i].detune);
            }
            catch(e){ /* the detune input is not connected: nothing to disconnect */ }
          };
          o[i].stop(t+p[0].d*this.releaseRatio);
        }
      }
      if(!this.rhythm[ch])
        this.notetab.push({t:t,e:99999,ch:ch,n:n,o:o,g:g,q:q,t2:t+pn.a,v:vp,r:r,f:0});
      else // tracked until it ends, so stops, seeks and dispose() reach it (#11, D-019)
        this._src.push({t:t,e:t+p[0].d*this.releaseRatio,ch:ch,o:o,g:g,q:q});
    },
    _setParamTarget:(p,v,t,d)=>{
      if(d!=0)
        p.setTargetAtTime(v,t,d);
      else
        p.setValueAtTime(v,t);
    },
    _releaseNote:(nt,t)=>{
      if(nt.ch!=9){
        for(let k=nt.g.length-1;k>=0;--k){
          nt.g[k].gain.cancelScheduledValues(t);
          if(t==nt.t2)
            nt.g[k].gain.setValueAtTime(nt.v[k],t);
          else if(t<nt.t2)
            nt.g[k].gain.setValueAtTime(nt.v[k]*(t-nt.t)/(nt.t2-nt.t),t);
          this._setParamTarget(nt.g[k].gain,0,t,nt.r[k]);
        }
      }
      nt.e=t+nt.r[0]*this.releaseRatio;
      nt.f=1;
    },
    setModulation:(ch,v,t)=>{
      if(!this._live())
        return;
      this.chmod[ch].gain.setValueAtTime(this._m[ch]=v*100/127,this._tsConv(t));
    },
    setChVol:(ch,v,t)=>{
      if(!this._live())
        return;
      this.vol[ch]=3*v*v/(127*127);
      this.chvol[ch].gain.setValueAtTime(this.vol[ch]*this.ex[ch],this._tsConv(t));
    },
    setPan:(ch,v,t)=>{
      if(!this._live())
        return;
      if(this.chpan[ch])
        this.chpan[ch].pan.setValueAtTime(this._p[ch]=(v-64)/64,this._tsConv(t));
    },
    setExpression:(ch,v,t)=>{
      if(!this._live())
        return;
      this.ex[ch]=v*v/(127*127);
      this.chvol[ch].gain.setValueAtTime(this.vol[ch]*this.ex[ch],this._tsConv(t));
    },
    setSustain:(ch,v,t)=>{
      if(!this._live())
        return;
      this.sustain[ch]=v;
      t=this._tsConv(t);
      if(v<64){
        for(let i=this.notetab.length-1;i>=0;--i){
          const nt=this.notetab[i];
          if(t>=nt.t && nt.ch==ch && nt.f==1)
            this._releaseNote(nt,t);
        }
      }
    },
    allSoundOff:(ch)=>{
      for(let i=this.notetab.length-1;i>=0;--i){
        const nt=this.notetab[i];
        if(nt.ch==ch){
          this._pruneNote(nt);
          this.notetab.splice(i,1);
        }
      }
    },
    resetAllControllers:(ch)=>{
      this.bend[ch]=0; this.ex[ch]=1.0;
      this.rpnidx[ch]=0x3fff; this.sustain[ch]=0;
      if(this.chvol[ch]){
        this.chvol[ch].gain.value=this.vol[ch]*this.ex[ch];
        this.chmod[ch].gain.value=this._m[ch]=0;
      }
    },
    setBendRange:(ch,v)=>{
      if(!this._live())
        return;
      this.brange[ch]=v;
    },
    setProgram:(ch,v)=>{
      if(!this._live())
        return;
      if(this.debug)
        console.log("Pg("+ch+")="+v);
      this.pg[ch]=v;
    },
    _tsConv:(t)=>{
      if(t==undefined||t<=0){
        t=0;
        if(this.actx)
          t=this.actx.currentTime;
      }
      else{
        if(this.tsmode)
          t=t*.001-this.tsdiff;
      }
      return t;
    },
    setBend:(ch,v,t)=>{
      if(!this._live())
        return;
      t=this._tsConv(t);
      const br=this.brange[ch]*100/127;
      this.bend[ch]=(v-8192)*br/8192;
      for(let i=this.notetab.length-1;i>=0;--i){
        const nt=this.notetab[i];
        if(nt.ch==ch){
          for(let k=nt.o.length-1;k>=0;--k){
            if(nt.o[k].frequency)
              if (nt.o[k].detune) nt.o[k].detune.setValueAtTime(this.bend[ch],t);
          }
        }
      }
    },
    noteOff:(ch,n,t)=>{
      if(this.rhythm[ch])
        return;
      t=this._tsConv(t);
      for(let i=this.notetab.length-1;i>=0;--i){
        const nt=this.notetab[i];
        if(t>=nt.t && nt.ch==ch && nt.n==n && nt.f==0){
          nt.f=1;
          if(this.sustain[ch]<64)
            this._releaseNote(nt,t);
        }
      }
    },
    noteOn:(ch,n,v,t)=>{
      if(!this._live())
        return;
      if(v==0){
        this.noteOff(ch,n,t);
        return;
      }
      t=this._tsConv(t);
      if(this.rhythm[ch]){
        if(n>=35&&n<=81)
          this._note(t,ch,n,v,this.drummap[n-35].p);
        return;
      }
      this._note(t,ch,n,v,this.program[this.pg[ch]].p);
    },
    setTsMode:(tsmode)=>{
      this.tsmode=tsmode;
    },
    send:(msg,t)=>{    /* send midi message */
      if(!this._live())
        return;
      const ch=msg[0]&0xf;
      const cmd=msg[0]&~0xf;
      if(cmd<0x80||cmd>=0x100)
        return;
      this._wake();
      switch(cmd){
      case 0xb0:  /* ctl change */
        switch(msg[1]){
        case 1:  this.setModulation(ch,msg[2],t); break;
        case 7:  this.setChVol(ch,msg[2],t); break;
        case 10: this.setPan(ch,msg[2],t); break;
        case 11: this.setExpression(ch,msg[2],t); break;
        case 64: this.setSustain(ch,msg[2],t); break;
        case 98:  case 99: this.rpnidx[ch]=0x3fff; break; /* nrpn lsb/msb */
        case 100: this.rpnidx[ch]=(this.rpnidx[ch]&0x3f80)|msg[2]; break; /* rpn lsb */
        case 101: this.rpnidx[ch]=(this.rpnidx[ch]&0x7f)|(msg[2]<<7); break; /* rpn msb */
        case 6:  /* data entry msb */
          switch (this.rpnidx[ch]) {
            case 0:
              this.brange[ch]=(msg[2]<<7)+(this.brange[ch]&0x7f);
              break;
            case 1:
              this.tuningF[ch]=(msg[2]<<7)+((this.tuningF[ch]+0x2000)&0x7f)-0x2000;
              break;
            case 2:
              this.tuningC[ch]=msg[2]-0x40;
              break;
          }
          break;
        case 38:  /* data entry lsb */
          switch (this.rpnidx[ch]) {
            case 0:
              this.brange[ch]=(this.brange[ch]&0x3f80)|msg[2];
              break;
            case 1:
              this.tuningF[ch]=(((this.tuningF[ch]+0x2000)&0x3f80)|msg[2])-0x2000;
              break;
            case 2: break;
          }
          break;
        case 120:  /* all sound off */
        case 123:  /* all notes off */
        case 124: case 125: case 126: case 127: /* omni off/on mono/poly */
          this.allSoundOff(ch);
          break;
        case 121: this.resetAllControllers(ch); break;
        }
        break;
      case 0xc0: this.setProgram(ch,msg[1]); break;
      case 0xe0: this.setBend(ch,(msg[1]+(msg[2]<<7)),t); break;
      case 0x90: this.noteOn(ch,msg[1],msg[2],t); break;
      case 0x80: this.noteOff(ch,msg[1],t); break;
      case 0xf0:
        if (msg[0] == 0xff) {
          this.reset();
          break;
        }
        if(msg[0]!=254 && this.debug){
          var ds=[];
          for(let ii=0;ii<msg.length;++ii)
            ds.push(msg[ii].toString(16));
        }
        if (msg[0]==0xf0) {
          if (msg[1]==0x7f && msg[3]==4) {
            if (msg[4]==3 && msg.length >= 8) { // Master Fine Tuning
              this.masterTuningF = (msg[6]*0x80 + msg[5] - 8192) / 8192;
            }
            if (msg[4]==4 && msg.length >= 8) { // Master Coarse Tuning
              this.masterTuningC = msg[6]-0x40;
            }
          }
          if (msg[1]==0x41 && msg[3]==0x42 && msg[4]==0x12 &&msg[5]==0x40) { // GS
            if ((msg[6]&0xf0)==0x10 && msg.length==11) {
              const c=[9,0,1,2,3,4,5,6,7,8,10,11,12,13,14,15][msg[6]&0xf];
              if (msg[7]==0x15) {
                this.rhythm[c]=msg[8];
              }
              else if (msg[7] >= 0x40 && msg[7] <= 0x4b) { // Scale Tuning
                this.scaleTuning[c][msg[7]-0x40] = (msg[8]-0x40) / 100;
              }
            }
            else if (msg[6]==0) {
              if (msg[7]==0 && msg.length==14) { // Master Tuning
                this.masterTuningF = (msg[8]*0x1000 + msg[9]*0x100 + msg[10]*0x10 + msg[11] - 0x400) / 1000;
              }
              else if (msg[7]==5 && msg.length==11) { // Master Transpose
                this.masterTuningC = msg[8]-0x40;
              }
            }
          }
        }
        break;
      }
    },
    _createWave:(w)=>{
      const imag=new Float32Array(w.length);
      const real=new Float32Array(w.length);
      for(let i=1;i<w.length;++i)
        imag[i]=w[i];
      return this.actx.createPeriodicWave(real,imag);
    },
    setHarmonicWave:(w,real,imag)=>{
      /* Registers PeriodicWave w (#26, D-006, D-028): real and imag are equal-length arrays of at
         least 2 numbers, finite as floats. Index 0 (DC) is set to 0, and the browser normalizes
         the peak to 1. */
      this._reg("w",w,[real,imag],2,x=>isFinite(Math.fround(x)),"real, imag: equal-length arrays of >= 2 finite numbers");
    },
    setSampleWave:(w,samples)=>{
      /* Registers single-cycle table w (#26, D-027, D-028): an array of at least 1 number in [-1, 1]. */
      this._reg("n",w,[samples],1,x=>x>=-1 && x<=1,"samples: an array of numbers in [-1, 1]");
    },
    _reg:(k,w,a,m,f,s)=>{
      /* Checks the name (D-006: k, a letter or _, then up to 30 of [A-Za-z0-9_]; a digit second is
         reserved for built-ins), then the arrays a: each an Array or typed array of at least m
         numbers that pass f, as long as the first (else a TypeError s if not an array, a RangeError
         s otherwise), each read once. Copies them as Float32Arrays. A PeriodicWave's DC is set to 0,
         and coefficients whose largest magnitude is extreme are scaled by a power of two, which the
         browser's normalization undoes (browsers render NaN from 1e36 or a lone subnormal, and
         Firefox keeps the NaN in the graph). Then builds the wave in the installed context; only
         then is anything stored, so a failure changes nothing. Re-registering a name replaces it:
         sounding voices keep the old wave, later notes get the new one. */
      if(typeof w!="string" || w[0]!=k || !/^.[A-Za-z_]\w{0,30}$/.test(w))
        throw new TypeError("wave name: "+w);
      const d=a.map(x=>{
        if(!Array.isArray(x) && !ArrayBuffer.isView(x))
          throw new TypeError(s);
        x=Array.from(x);
        if(!(x.length>=m && x.length==a[0].length && x.every(v=>typeof v=="number" && f(v))))
          throw new RangeError(s);
        return Float32Array.from(x);
      });
      if(d[1]){
        let e=0;
        d[0][0]=d[1][0]=0;
        d.forEach(a=>a.forEach(v=>e=Math.max(e,Math.abs(v))));
        if(e>1e9 || e && e<1e-9){
          e=Math.pow(2,-Math.round(Math.log2(e)));
          d.forEach(a=>a.forEach((v,i)=>a[i]=v*e));
        }
      }
      const o=this.actx && this._mk(d,this.actx);
      this._wv.set(w,d);
      if(o)
        (k=="n" ? this.noiseBuf : this.wave)[w]=o;
    },
    _mk:(d,c)=>{
      /* Returns registered wave d built in context c: a PeriodicWave from [real, imag], or an
         AudioBuffer of the table [samples] with each of its N samples held for
         k = max(1, round(sampleRate/(440*N))) frames, so its home pitch sampleRate/(N*k) is near
         440 Hz and notes play near rate 1 with sharp steps (D-027). One guard frame, the first
         sample again, follows the N*k frames, and _note loops only those: Chromium otherwise
         misplays the loop's first frame for some lengths (D-031); the other engines play the same
         either way. The buffer is tagged with its home pitch (_b) and loop end (_l). */
      const s=d[0],N=s.length,k=Math.max(1,Math.round(c.sampleRate/(440*N)));
      if(d[1])
        return c.createPeriodicWave(s,d[1]);
      const b=c.createBuffer(1,N*k+1,c.sampleRate),x=b.getChannelData(0);
      for(let i=0;i<=N;++i) // i = N writes the guard frame (fill stops at the end)
        x.fill(s[i%N],i*k,i*k+k);
      b._b=c.sampleRate/(N*k);
      b._l=N*k/c.sampleRate;
      return b;
    },
    getAudioContext:()=>{
      return this.actx;
    },
    setAudioContext:(actx,dest)=>{
      /* Invalid arguments throw a TypeError before anything changes. The previous graph is
         torn down first, and its context closed if the synth created it (#11). The new
         context belongs to the caller and is never closed by the synth. On an
         OfflineAudioContext, MIDI playback stops (playMIDI needs a realtime context). */
      if(this._dead)
        return;
      this._check(actx,dest);
      /* The registered waves are built for the new context first, so a failure leaves the
         installed graph as it was (#26). */
      const r=[...this._wv].map(([w,d])=>[w,this._mk(d,actx)]);
      const own=this._own && actx==this.actx;
      this._drop(this._own && !own);
      this._own=own;
      if((this._off=typeof actx.startRendering=="function"))
        this.playing=0;
      this.audioContext=this.actx=actx;
      this.dest=dest;
      if(!dest)
        this.dest=actx.destination;
      this.tsdiff=performance.now()*.001-this.actx.currentTime;
      if(this.debug)
        console.log("TSDiff:"+this.tsdiff);
      this.out=this.actx.createGain();
      this.comp=this.actx.createDynamicsCompressor();
      var blen=this.actx.sampleRate*.5|0;
      this.convBuf=this.actx.createBuffer(2,blen,this.actx.sampleRate);
      this.noiseBuf={};
      this.noiseBuf.n0=this.actx.createBuffer(1,blen,this.actx.sampleRate);
      this.noiseBuf.n1=this.actx.createBuffer(1,blen,this.actx.sampleRate);
      var d1=this.convBuf.getChannelData(0);
      var d2=this.convBuf.getChannelData(1);
      var dn=this.noiseBuf.n0.getChannelData(0);
      var dr=this.noiseBuf.n1.getChannelData(0);
      const rnd=k=>mulberry32(this.seed+k*0x40000000); // stream k (see mulberry32)
      let g=rnd(0);
      for(let i=0;i<blen;++i){
        if(i/blen<g()){
          d1[i]=Math.exp(-3*i/blen)*(g()-.5)*.5;
          d2[i]=Math.exp(-3*i/blen)*(g()-.5)*.5;
        }
      }
      g=rnd(1);
      for(let i=0;i<blen;++i)
        dn[i]=g()*2-1;
      g=rnd(2);
      for(let jj=0;jj<64;++jj){
        const r1=g()*10+1;
        const r2=g()*10+1;
        for(let i=0;i<blen;++i){
          var dd=Math.sin((i/blen)*2*Math.PI*440*r1)*Math.sin((i/blen)*2*Math.PI*440*r2);
          dr[i]+=dd/8;
        }
      }
      if(this.useReverb){
        this.conv=this.actx.createConvolver();
        this.conv.buffer=this.convBuf;
        this.rev=this.actx.createGain();
        this.rev.gain.value=this.reverbLev;
        this.out.connect(this.conv);
        this.conv.connect(this.rev);
        this.rev.connect(this.comp);
      }
      this.setMasterVol();
      this.out.connect(this.comp);
      this.comp.connect(this.dest);
      this.chvol=[]; this.chmod=[]; this.chpan=[];
      this.wave={"w9999":this._createWave("w9999")};
      r.forEach(([w,x])=>(w[0]=="n" ? this.noiseBuf : this.wave)[w]=x);
      this.lfo=this.actx.createOscillator();
      this.lfo.frequency.value=5;
      this.lfo.start(0);
      for(let i=0;i<16;++i){
        this.chvol[i]=this.actx.createGain();
        if(this.actx.createStereoPanner){
          this.chpan[i]=this.actx.createStereoPanner();
          this.chvol[i].connect(this.chpan[i]);
          this.chpan[i].connect(this.out);
        }
        else{
          this.chpan[i]=null;
          this.chvol[i].connect(this.out);
        }
        this.chmod[i]=this.actx.createGain();
        this.lfo.connect(this.chmod[i]);
        this.pg[i]=0;
        this.resetAllControllers(i);
      }
      this.setReverbLev();
      this.reset();
      this.send([0x90,60,1]);
      this.send([0x90,60,0]);
    },
  });
}

class WebAudioTinySynth {
  constructor(opt){
    WebAudioTinySynthCore.bind(this)(this);
    for(let k in this.properties){
      this[k]=this.properties[k].value;
    }
    /* Lifecycle options (#12), checked before anything is created: a caller-owned context
       and destination, or lazy: true to create the internal context on first use. */
    const {context:c,destination:d,lazy:l}=opt||{};
    if(l!=undefined && typeof l!="boolean" || l && c!=undefined)
      throw new TypeError("lazy");
    if(c!=undefined || d!=undefined) // a destination without a context fails as "context"
      this._check(c,d);
    /* The buffer seed (#7, D-004), also checked first: an integer from 0 to 2^32-1, default
       0. The seed and the buffer generation version are read-only properties. */
    const {seed:s=0}=opt||{};
    if(typeof s!="number")
      throw new TypeError("seed must be a number");
    if(!(s>=0 && s<=4294967295 && s%1==0))
      throw new RangeError("seed must be an integer from 0 to 4294967295");
    Object.defineProperties(this,{seed:{value:s>>>0,enumerable:true},bufferVersion:{value:1,enumerable:true}});
    this._lazy=l;
    this.setQuality(1);
    if(opt){
      if(opt.useReverb!=undefined)
        this.useReverb=opt.useReverb;
      if(opt.quality!=undefined)
        this.setQuality(opt.quality);
      if(opt.voices!=undefined)
        this.setVoices(opt.voices);
    }
    this.init(c,d);
  }
}

if(typeof exports === 'object' && typeof module !== 'undefined'){
  module.exports = WebAudioTinySynth;
}
else if(typeof define === 'function' && define.amd){
    define(function(){
      return WebAudioTinySynth;
    });
}
else{
  window.WebAudioTinySynth = WebAudioTinySynth;
}

})(this);
