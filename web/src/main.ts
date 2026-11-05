import './styles/theme.css';
import { noPinch } from './lib/noPinch';
import { mount } from 'svelte';
import App from './App.svelte';

noPinch();

mount(App, { target: document.getElementById('root')! });
